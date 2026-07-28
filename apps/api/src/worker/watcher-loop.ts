import {
  matchPayment,
  type LinkRepository,
  type PaymentLink,
  type WatcherPort,
  type WatcherStateRepository,
} from "@checkout/core";
import { AnchorHealth, type LinkService } from "../services/link-service";

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
    const accounts = await this.deps.links.activeDestinations();
    for (const account of accounts) {
      try {
        await this.processAccount(account);
      } catch (err) {
        this.deps.log?.(`watcher account ${short(account)} error: ${stringifyErr(err)}`);
      }
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

/**
 * Periodically run the anchor health probe. First probe runs immediately so
 * the breaker state is correct on first request rather than after one interval
 * has elapsed. Probe failures never throw; AnchorHealth records every outcome.
 */
export function startAnchorProbeTimer(health: AnchorHealth, intervalMs: number): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  const tick = async () => {
    if (stopped) return;
    try {
      await health.probe();
    } catch {
      // AnchorHealth.probe() is contractually non-throwing; defensive only.
    }
    if (!stopped) timer = setTimeout(tick, intervalMs);
  };
  void tick();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
  };
}

function short(s: string): string {
  return s.length > 12 ? `${s.slice(0, 6)}…${s.slice(-4)}` : s;
}
function stringifyErr(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
