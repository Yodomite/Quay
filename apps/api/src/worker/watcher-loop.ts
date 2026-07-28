import {
  matchPayment,
  type LinkRepository,
  type PaymentLink,
  type WatcherPort,
  type WatcherStateRepository,
} from "@checkout/core";
import type { LinkService } from "../services/link-service";

/**
 * Polling settlement watcher.
 *
 * Each tick, for every account that has open links, we pull payments after the
 * stored cursor and match them to links by memo. Idempotency is layered:
 *   1. the persisted cursor means we don't refetch already-seen operations;
 *   2. the processed-tx ledger guards the crash window before a cursor is saved;
 *   3. the domain transition guard means a duplicate can never double-apply.
 */
export class WatcherLoop {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly deps: {
      watcher: WatcherPort;
      links: LinkRepository;
      state: WatcherStateRepository;
      service: LinkService;
      pollMs: number;
      log?: (msg: string) => void;
    },
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    const tick = async () => {
      if (!this.running) return;
      try {
        await this.runOnce();
      } catch (err) {
        this.deps.log?.(`watcher tick error: ${stringifyErr(err)}`);
      } finally {
        if (this.running) this.timer = setTimeout(tick, this.deps.pollMs);
      }
    };
    void tick();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  async runOnce(): Promise<void> {
    // Payment matching runs FIRST so a buyer who submitted within TTL but whose
    // on-chain confirmation lands after the deadline still settles as `paid`
    // (vs. being rejected because we already flipped the link to `expired`).
    // The expiry sweep runs AFTER — all `active`/`underpaid` links with
    // `expiresAt < now` flip to `expired` and fire `link.expired`. In the
    // next tick, `activeDestinations()` no longer lists them so we stop
    // polling Horizon for those accounts.
    const accounts = await this.deps.links.activeDestinations();
    for (const account of accounts) {
      try {
        await this.processAccount(account);
      } catch (err) {
        this.deps.log?.(`watcher account ${short(account)} error: ${stringifyErr(err)}`);
      }
    }

    try {
      const moved = await this.deps.service.sweepExpired(Date.now());
      if (moved > 0) this.deps.log?.(`expiry sweep moved ${moved} link(s) to expired`);
    } catch (err) {
      this.deps.log?.(`expiry sweep error: ${stringifyErr(err)}`);
    }
  }

  private async processAccount(account: string): Promise<void> {
    const cursor = await this.deps.state.getCursor(account);

    // First time we watch this account: seed the cursor to "now" so we only
    // react to payments that arrive after watching begins (no history replay).
    if (cursor === null) {
      const latest = await this.deps.watcher.latestCursor(account);
      await this.deps.state.setCursor(account, latest ?? "");
      return;
    }

    const payments = await this.deps.watcher.fetchSince(account, cursor);
    if (payments.length === 0) return;

    const open = await this.deps.links.openLinksForDestination(account);
    const byRef = new Map<string, PaymentLink>(open.map((l) => [l.reference, l]));

    let lastToken = cursor;
    for (const payment of payments) {
      lastToken = payment.pagingToken;
      if (await this.deps.state.isProcessed(payment.txHash)) continue;

      const outcome = matchPayment(payment, (ref) => byRef.get(ref));
      const linkId =
        outcome.kind === "paid" || outcome.kind === "underpaid" || outcome.kind === "asset_mismatch"
          ? outcome.link.id
          : null;

      if (outcome.kind === "paid" || outcome.kind === "underpaid") {
        const becamePaid = await this.deps.service.applyMatch(payment, outcome);
        this.deps.log?.(
          `payment ${short(payment.txHash)} -> ${outcome.kind}` +
            (becamePaid ? ` (link ${linkId} PAID)` : ""),
        );
      } else if (
        outcome.kind === "unknown_reference" &&
        payment.memo &&
        payment.memoType !== "none"
      ) {
        // Memo matched nothing in the OPEN set. Before we give up, check
        // whether the memo belongs to a link that *used to* be open but has
        // since been expired or cancelled by the seller. If so, the buyer
        // paid a dead link: do NOT resurrect it, fire payment.unmatched so
        // the seller can refund the buyer out-of-band.
        const terminal = await this.deps.links.findByReference(payment.memo);
        if (
          terminal &&
          terminal.destination === account &&
          (terminal.status === "expired" || terminal.status === "cancelled")
        ) {
          await this.deps.service.recordUnmatchedPayment(payment, terminal);
          this.deps.log?.(
            `payment ${short(payment.txHash)} -> unmatched against ` +
              `${terminal.status} link ${terminal.id}`,
          );
        }
      }

      await this.deps.state.markProcessed(payment.txHash, linkId);
    }

    await this.deps.state.setCursor(account, lastToken);
  }
}

/** Periodically advance any pending seller cash-outs. */
export function startCashOutPoller(service: LinkService, intervalMs: number): () => void {
  const timer = setInterval(() => {
    void service.pollCashOuts().catch(() => {});
  }, intervalMs);
  return () => clearInterval(timer);
}

function short(s: string): string {
  return s.length > 12 ? `${s.slice(0, 6)}…${s.slice(-4)}` : s;
}
function stringifyErr(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
