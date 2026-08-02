import {
  matchPayment,
  type LinkRepository,
  type PaymentLink,
  type WatcherPort,
  type WatcherStateRepository,
} from "@checkout/core";
import { AnchorHealth, type LinkService } from "../services/link-service";
import { env } from "../env";
import { metrics } from "../metrics";

/**
 * Per-account state for adaptive polling and circuit breaking.
 */
interface AccountState {
  consecutiveErrors: number;
  lastErrorTime: number;
  consecutiveIdleTicks: number;
  lastActivityTime: number;
  isNewAccount: boolean;
  lastProcessedAt: number;
}

/**
 * Circuit breaker status for a single account.
 */
export interface AccountCircuitBreakerStatus {
  account: string;
  isOpen: boolean;
  consecutiveErrors: number;
  lastErrorTime: number;
  cooldownUntil: number;
}

/**
 * Watcher metrics for observability.
 */
export interface WatcherMetrics {
  accountsWatched: number;
  tickDurationMs: number;
  perAccountLag: Map<string, number>;
  circuitBreakersOpen: number;
}

/**
 * Polling settlement watcher with bounded-concurrency fan-out and fairness.
 *
 * Each tick, we process accounts with:
 *   - Bounded concurrency (default 10) instead of sequential processing
 *   - Per-account adaptive intervals (back off idle, poll aggressive new links)
 *   - Per-account circuit breakers to isolate failing accounts
 *   - Fair round-robin cursor to prevent account starvation
 *   - Metrics for observability
 *
 * Idempotency is layered:
 *   1. the persisted cursor means we don't refetch already-seen operations;
 *   2. the processed-tx ledger guards the crash window before a cursor is saved;
 *   3. the domain transition guard means a duplicate can never double-apply.
 */
export class WatcherLoop {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private currentTick: Promise<void> | null = null;
  private accountStates = new Map<string, AccountState>();
  private roundRobinCursor = 0;
  private metrics: WatcherMetrics = {
    accountsWatched: 0,
    tickDurationMs: 0,
    perAccountLag: new Map(),
    circuitBreakersOpen: 0,
  };
  private lastTickCompletedAt = Date.now();

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
    const scheduleNext = () => {
      if (!this.running) return;
      this.timer = setTimeout(tick, this.deps.pollMs);
    };
    const tick = () => {
      if (!this.running) return;
      this.currentTick = this.runOnce()
        .catch((err) => {
          this.deps.log?.(`watcher tick error: ${stringifyErr(err)}`);
        })
        .finally(() => {
          this.currentTick = null;
          scheduleNext();
        });
    };
    void tick();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Seconds since the last fully-completed poll tick, computed at call time. */
  getLagSeconds(): number {
    return (Date.now() - this.lastTickCompletedAt) / 1000;
  }

  /**
   * Get current circuit breaker status for all accounts.
   */
  getCircuitBreakerStatus(): AccountCircuitBreakerStatus[] {
    const now = Date.now();
    const statuses: AccountCircuitBreakerStatus[] = [];
    
    for (const [account, state] of this.accountStates.entries()) {
      const isOpen = this.isCircuitBreakerOpen(account, state, now);
      statuses.push({
        account: short(account),
        isOpen,
        consecutiveErrors: state.consecutiveErrors,
        lastErrorTime: state.lastErrorTime,
        cooldownUntil: state.lastErrorTime + env.watcherCircuitBreakerCooldownMs,
      });
    }
    
    return statuses;
  }

  /**
   * Get current watcher metrics.
   */
  getMetrics(): WatcherMetrics {
    return { ...this.metrics, perAccountLag: new Map(this.metrics.perAccountLag) };
  }

  async runOnce(): Promise<void> {
    const tickStart = Date.now();
    const allAccounts = await this.deps.links.activeDestinations();
    this.metrics.accountsWatched = allAccounts.length;
    metrics.accountsWatched.set(allAccounts.length);

    // Select accounts to process this tick using fair round-robin
    const accountsToProcess = this.selectAccountsForTick(allAccounts);
    
    // Process with bounded concurrency
    const concurrency = env.watcherConcurrency;
    const chunks = this.chunkArray(accountsToProcess, concurrency);
    
    for (const chunk of chunks) {
      await Promise.allSettled(
        chunk.map((account) => this.processAccountWithCircuitBreaker(account))
      );
    }

    // Update metrics
    const tickDuration = Date.now() - tickStart;
    this.metrics.tickDurationMs = tickDuration;
    this.metrics.circuitBreakersOpen = this.countOpenCircuitBreakers();
    metrics.watcherTickDurationSeconds.observe(tickDuration / 1000);

    // Update per-account lag
    const now = Date.now();
    for (const [account, state] of this.accountStates.entries()) {
      const lag = now - state.lastProcessedAt;
      this.metrics.perAccountLag.set(account, lag);
    }
    this.lastTickCompletedAt = now;

    // Expiry sweep runs AFTER payment matching, so a buyer who submitted within
    // TTL but whose on-chain confirmation lands after the deadline still settles
    // as `paid` rather than being rejected against an already-expired link.
    try {
      const moved = await this.deps.service.sweepExpired(Date.now());
      if (moved > 0) this.deps.log?.(`expiry sweep moved ${moved} link(s) to expired`);
    } catch (err) {
      this.deps.log?.(`expiry sweep error: ${stringifyErr(err)}`);
    }
  }

  /**
   * Select accounts for this tick using fair round-robin to prevent starvation.
   */
  private selectAccountsForTick(allAccounts: string[]): string[] {
    if (allAccounts.length === 0) return [];
    
    const maxPerTick = env.watcherMaxAccountsPerTick;
    if (allAccounts.length <= maxPerTick) {
      return allAccounts;
    }

    // Round-robin selection starting from cursor
    const selected: string[] = [];
    for (let i = 0; i < maxPerTick && i < allAccounts.length; i++) {
      const index = (this.roundRobinCursor + i) % allAccounts.length;
      const account = allAccounts[index];
      if (account !== undefined) {
        selected.push(account);
      }
    }

    // Advance cursor for next tick
    this.roundRobinCursor = (this.roundRobinCursor + maxPerTick) % allAccounts.length;
    
    return selected;
  }

  /**
   * Process account with circuit breaker protection.
   */
  private async processAccountWithCircuitBreaker(account: string): Promise<void> {
    const state = this.getOrCreateAccountState(account);
    const now = Date.now();

    // Check circuit breaker
    if (this.isCircuitBreakerOpen(account, state, now)) {
      this.deps.log?.(`watcher account ${short(account)} circuit breaker open, skipping`);
      return;
    }

    // Check adaptive interval - skip if idle for too long
    if (state.consecutiveIdleTicks >= env.watcherIdleBackoffTicks && !state.isNewAccount) {
      this.deps.log?.(`watcher account ${short(account)} idle for ${state.consecutiveIdleTicks} ticks, backing off`);
      state.consecutiveIdleTicks++;
      return;
    }

    try {
      await this.processAccount(account);
      
      // Reset error state on success
      state.consecutiveErrors = 0;
      state.lastActivityTime = now;
      state.isNewAccount = false;
      state.lastProcessedAt = now;
      
    } catch (err) {
      state.consecutiveErrors++;
      state.lastErrorTime = now;
      
      // Check if we should open circuit breaker
      if (state.consecutiveErrors >= env.watcherCircuitBreakerThreshold) {
        this.deps.log?.(
          `watcher account ${short(account)} circuit breaker opened after ${state.consecutiveErrors} errors`
        );
      }
      
      this.deps.log?.(`watcher account ${short(account)} error: ${stringifyErr(err)}`);
    }
  }

  /**
   * Check if circuit breaker is open for an account.
   */
  private isCircuitBreakerOpen(account: string, state: AccountState, now: number): boolean {
    if (state.consecutiveErrors < env.watcherCircuitBreakerThreshold) {
      return false;
    }
    
    const cooldownEnd = state.lastErrorTime + env.watcherCircuitBreakerCooldownMs;
    return now < cooldownEnd;
  }

  /**
   * Count currently open circuit breakers.
   */
  private countOpenCircuitBreakers(): number {
    const now = Date.now();
    let count = 0;
    
    for (const [account, state] of this.accountStates.entries()) {
      if (this.isCircuitBreakerOpen(account, state, now)) {
        count++;
      }
    }
    
    return count;
  }

  /**
   * Get or create account state.
   */
  private getOrCreateAccountState(account: string): AccountState {
    if (!this.accountStates.has(account)) {
      this.accountStates.set(account, {
        consecutiveErrors: 0,
        lastErrorTime: 0,
        consecutiveIdleTicks: 0,
        lastActivityTime: Date.now(),
        isNewAccount: true,
        lastProcessedAt: Date.now(),
      });
    }
    return this.accountStates.get(account)!;
  }

  /**
   * Split array into chunks of given size.
   */
  private chunkArray<T>(array: T[], chunkSize: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < array.length; i += chunkSize) {
      chunks.push(array.slice(i, i + chunkSize));
    }
    return chunks;
  }

  private async processAccount(account: string): Promise<void> {
    const cursor = await this.deps.state.getCursor(account);
    const state = this.getOrCreateAccountState(account);

    // First time we watch this account: seed the cursor to "now" so we only
    // react to payments that arrive after watching begins (no history replay).
    if (cursor === null) {
      const latest = await this.deps.watcher.latestCursor(account);
      await this.deps.state.setCursor(account, latest ?? "");
      return;
    }

    const payments = await this.deps.watcher.fetchSince(account, cursor);
    
    // Track idle ticks for adaptive polling
    if (payments.length === 0) {
      state.consecutiveIdleTicks++;
      return;
    }

    state.consecutiveIdleTicks = 0;

    const open = await this.deps.links.openLinksForDestination(account);
    const byRef = new Map<string, PaymentLink>(open.map((l) => [l.reference, l]));
    const byMuxedId = new Map<string, PaymentLink>(
      open.filter((l) => l.muxedId).map((l) => [l.muxedId as string, l]),
    );

    let lastToken = cursor;
    for (const payment of payments) {
      lastToken = payment.pagingToken;
      if (await this.deps.state.isProcessed(payment.txHash)) continue;

      const outcome = matchPayment(payment, (ref) => byRef.get(ref), (id) => byMuxedId.get(id));
      metrics.paymentsMatchedTotal.inc({ outcome: outcome.kind });
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
