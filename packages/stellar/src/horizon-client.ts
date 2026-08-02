import { Horizon } from "@stellar/stellar-sdk";

/**
 * Slice of the Horizon SDK's payments call-builder that both watcher
 * implementations depend on. Extracted so tests can inject an in-memory fake
 * and run the exact same contract suite against real-shaped code, without a
 * live Horizon instance.
 */
export interface PaymentsCallBuilder {
  forAccount(account: string): PaymentsCallBuilder;
  order(direction: "asc" | "desc"): PaymentsCallBuilder;
  limit(n: number): PaymentsCallBuilder;
  cursor(token: string): PaymentsCallBuilder;
  /** `join=transactions` — embeds each operation's transaction in the same
   *  response, so reading a memo costs no follow-up request (issue #11). */
  join(resource: "transactions"): PaymentsCallBuilder;
  call(): Promise<{ records: HorizonPaymentRecord[] }>;
  stream(opts: {
    onmessage: (record: HorizonPaymentRecord) => void;
    onerror: (err: unknown) => void;
  }): () => void;
}

/** Slice of a Horizon account's balances that preflight checks care about. */
export interface HorizonAccountBalance {
  asset_type: string;
  asset_code?: string;
  asset_issuer?: string;
  balance: string;
  limit?: string;
}

export interface HorizonAccount {
  balances: HorizonAccountBalance[];
}

export interface HorizonClient {
  payments(): PaymentsCallBuilder;
  loadAccount(account: string): Promise<HorizonAccount>;
}

export type HorizonPaymentRecord =
  | Horizon.ServerApi.PaymentOperationRecord
  | Horizon.ServerApi.OperationRecord;

/** Wraps a real `Horizon.Server` so it satisfies `HorizonClient` structurally. */
export function realHorizonClient(horizonUrl: string): HorizonClient {
  return new Horizon.Server(horizonUrl) as unknown as HorizonClient;
}

export function isNotFound(err: unknown): boolean {
  const e = err as { response?: { status?: number }; name?: string };
  return e?.response?.status === 404 || e?.name === "NotFoundError";
}
