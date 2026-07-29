import type { HorizonClient, HorizonPaymentRecord, PaymentsCallBuilder } from "../src/horizon-client";

interface Listener {
  onmessage: (record: HorizonPaymentRecord) => void;
  onerror: (err: unknown) => void;
}

export interface FakePaymentInput {
  account: string;
  to?: string;
  from?: string;
  amount?: string;
  assetCode?: string;
  assetIssuer?: string | null;
  memo?: string | null;
  memoType?: string | null;
  type?: string; // defaults to "payment"; set e.g. "create_account" to test filtering
}

/**
 * In-memory stand-in for Horizon's payments endpoint (paged + SSE), structurally
 * compatible with `HorizonClient`. Lets the same contract test suite drive both
 * `HorizonWatcher` (call()) and `StreamingHorizonWatcher` (stream()) without a
 * live network.
 */
export class FakeHorizonClient implements HorizonClient {
  private nextToken = 1;
  private readonly ledger = new Map<string, HorizonPaymentRecord[]>();
  private readonly listeners = new Map<string, Set<Listener>>();
  private notFoundAccounts = new Set<string>();

  payments(): PaymentsCallBuilder {
    return new FakeBuilder(this);
  }

  /** Marks an account as never-created on-chain: call()/stream() surface a 404. */
  markNotFound(account: string): void {
    this.notFoundAccounts.add(account);
  }

  isNotFoundAccount(account: string): boolean {
    return this.notFoundAccounts.has(account);
  }

  recordsFor(account: string): HorizonPaymentRecord[] {
    return this.ledger.get(account) ?? [];
  }

  addPayment(input: FakePaymentInput): HorizonPaymentRecord {
    this.notFoundAccounts.delete(input.account);
    const token = String(this.nextToken++);
    const record = {
      type: input.type ?? "payment",
      paging_token: token,
      transaction_hash: `tx_${token}`,
      created_at: new Date().toISOString(),
      to: input.to ?? input.account,
      from: input.from ?? "GFROM_DEFAULT",
      amount: input.amount ?? "10",
      asset_type: input.assetCode ? "credit_alphanum4" : "native",
      asset_code: input.assetCode,
      asset_issuer: input.assetIssuer ?? undefined,
      transaction: async () => ({
        memo_type: input.memoType ?? (input.memo ? "text" : "none"),
        memo: input.memo ?? undefined,
      }),
    } as unknown as HorizonPaymentRecord;

    const list = this.ledger.get(input.account) ?? [];
    list.push(record);
    this.ledger.set(input.account, list);

    for (const listener of this.listeners.get(input.account) ?? []) {
      listener.onmessage(record);
    }
    return record;
  }

  /** Simulates a dropped SSE connection for every live subscriber on `account`. */
  killConnection(account: string, err: unknown = new Error("connection reset")): void {
    for (const listener of this.listeners.get(account) ?? []) {
      listener.onerror(err);
    }
  }

  liveSubscriberCount(account: string): number {
    return this.listeners.get(account)?.size ?? 0;
  }

  subscribe(account: string, listener: Listener): void {
    const set = this.listeners.get(account) ?? new Set();
    set.add(listener);
    this.listeners.set(account, set);
  }

  unsubscribe(account: string, listener: Listener): void {
    this.listeners.get(account)?.delete(listener);
  }
}

class FakeBuilder implements PaymentsCallBuilder {
  private account = "";
  private direction: "asc" | "desc" = "asc";
  private limitN = 200;
  private cursorToken = "";

  constructor(private readonly client: FakeHorizonClient) {}

  forAccount(account: string): PaymentsCallBuilder {
    this.account = account;
    return this;
  }
  order(direction: "asc" | "desc"): PaymentsCallBuilder {
    this.direction = direction;
    return this;
  }
  limit(n: number): PaymentsCallBuilder {
    this.limitN = n;
    return this;
  }
  cursor(token: string): PaymentsCallBuilder {
    this.cursorToken = token;
    return this;
  }

  async call(): Promise<{ records: HorizonPaymentRecord[] }> {
    if (this.client.isNotFoundAccount(this.account)) {
      const err = new Error("not found") as Error & { response: { status: number } };
      err.response = { status: 404 };
      throw err;
    }
    let records = this.client
      .recordsFor(this.account)
      .filter((r) => !this.cursorToken || Number((r as any).paging_token) > Number(this.cursorToken));
    records = [...records].sort((a, b) => Number((a as any).paging_token) - Number((b as any).paging_token));
    if (this.direction === "desc") records.reverse();
    return { records: records.slice(0, this.limitN) };
  }

  stream(opts: { onmessage: (record: HorizonPaymentRecord) => void; onerror: (err: unknown) => void }): () => void {
    const listener: Listener = { onmessage: opts.onmessage, onerror: opts.onerror };
    // Register before replaying the backlog: JS is single-threaded, so nothing
    // can append between these two statements and be missed or double-delivered.
    this.client.subscribe(this.account, listener);
    const backlog = this.client
      .recordsFor(this.account)
      .filter((r) => !this.cursorToken || Number((r as any).paging_token) > Number(this.cursorToken))
      .sort((a, b) => Number((a as any).paging_token) - Number((b as any).paging_token));
    for (const record of backlog) opts.onmessage(record);

    return () => this.client.unsubscribe(this.account, listener);
  }
}
