import type { Horizon } from "@stellar/stellar-sdk";
import type { NormalizedPayment, WatcherPort } from "@checkout/core";
import { normalizePayment, type FetchTransaction, type OperationWithTransaction } from "./normalize";
import { withHorizonRetry, type RetryOptions } from "./horizon-retry";
import { type HorizonClient, isNotFound, realHorizonClient } from "./horizon-client";

export interface HorizonStatus {
  /** True once consecutive failures have reached the degraded threshold. */
  degraded: boolean;
  /** True if currently routing calls to HORIZON_URL_FALLBACK instead of the primary. */
  usingFallback: boolean;
  consecutiveFailures: number;
}

export interface HorizonWatcherOptions {
  primaryServer: HorizonClient | string;
  /** Optional standby Horizon server. Switched to after `degradedThreshold`
   *  consecutive failures on the primary; switched back on the next success. */
  fallbackServer?: HorizonClient | string;
  /** Consecutive failures before considered degraded (and before switching to
   *  the fallback, if one is configured). Default 3. */
  degradedThreshold?: number;
  /** Passed straight through to `withHorizonRetry` for every call — mainly for
   *  tests to shrink the backoff delays; production can leave this unset. */
  retryOptions?: RetryOptions;
  log?: (msg: string) => void;
}

function toClient(target: HorizonClient | string): HorizonClient {
  return typeof target === "string" ? realHorizonClient(target) : target;
}

/**
 * Polling implementation of WatcherPort over Horizon.
 *
 * Polling (vs streaming) is deliberate for the MVP: it is restart-safe with a
 * persisted cursor and trivial to reason about. `StreamingHorizonWatcher`
 * satisfies the same interface for the WATCH_MODE=stream path.
 *
 * Every Horizon call goes through `withHorizonRetry` (3 attempts, exponential
 * backoff with full jitter, honoring `Retry-After` on 429) so a transient blip
 * resolves without an operator noticing. Sustained failure — retries exhausted
 * `degradedThreshold` times in a row — marks the watcher `degraded` (see
 * `getStatus()`, surfaced in `GET /health`) and, if `HORIZON_URL_FALLBACK` is
 * set, switches to it until the next successful call.
 */
export class HorizonWatcher implements WatcherPort {
  private readonly primaryClient: HorizonClient;
  private readonly fallbackClient: HorizonClient | null;
  private readonly degradedThreshold: number;
  private readonly retryOptions?: RetryOptions;
  private readonly log: (msg: string) => void;

  private usingFallback = false;
  private consecutiveFailures = 0;

  /** Accepts a bare Horizon URL or injected client (the original shape, still
   *  used by tests and the streaming path) or the full resilience options. */
  constructor(target: string | HorizonClient | HorizonWatcherOptions) {
    const opts: HorizonWatcherOptions =
      typeof target === "string" || !("primaryServer" in target)
        ? { primaryServer: target as string | HorizonClient }
        : target;
    this.primaryClient = toClient(opts.primaryServer);
    this.fallbackClient = opts.fallbackServer ? toClient(opts.fallbackServer) : null;
    this.degradedThreshold = opts.degradedThreshold ?? 3;
    this.retryOptions = opts.retryOptions;
    this.log = opts.log ?? (() => {});
  }

  getStatus(): HorizonStatus {
    return {
      degraded: this.consecutiveFailures >= this.degradedThreshold,
      usingFallback: this.usingFallback,
      consecutiveFailures: this.consecutiveFailures,
    };
  }

  private get client(): HorizonClient {
    return this.usingFallback && this.fallbackClient ? this.fallbackClient : this.primaryClient;
  }

  /** A 404 (missing account) is a legitimate, prompt answer — not a Horizon
   *  problem — so it counts as a success for degraded-tracking purposes. */
  private onOk(): void {
    if (this.consecutiveFailures > 0 || this.usingFallback) {
      this.log(
        `horizon_recovered${this.usingFallback ? " (was on HORIZON_URL_FALLBACK)" : ""} after ${this.consecutiveFailures} consecutive failure(s)`,
      );
    }
    this.consecutiveFailures = 0;
    this.usingFallback = false;
  }

  private onFail(err: unknown): void {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures < this.degradedThreshold) return;

    if (this.fallbackClient && !this.usingFallback) {
      this.usingFallback = true;
      this.log(
        `horizon_degraded — ${this.consecutiveFailures} consecutive failures, switching to HORIZON_URL_FALLBACK: ${stringifyErr(err)}`,
      );
    } else {
      this.log(
        `horizon_degraded — ${this.consecutiveFailures} consecutive failures${this.fallbackClient ? " (already on fallback)" : " (no HORIZON_URL_FALLBACK configured)"}: ${stringifyErr(err)}`,
      );
    }
  }

  /** Newest payment paging-token for an account, used to seed a fresh watch. */
  async latestCursor(account: string): Promise<string | null> {
    try {
      const page = await withHorizonRetry(
        () => this.client.payments().forAccount(account).order("desc").limit(1).call(),
        this.retryOptions,
      );
      this.onOk();
      const rec = page.records[0];
      return rec ? rec.paging_token : null;
    } catch (err) {
      if (isNotFound(err)) {
        this.onOk();
        return null; // account not yet created on-chain
      }
      this.onFail(err);
      throw err;
    }
  }

  /** Value payments on this account after `cursor`, oldest-first.
   *  Includes both directions; the matcher gates correctness on destination,
   *  and the worker advances the cursor by the last token returned here.
   *
   *  `join("transactions")` has Horizon embed each payment's parent
   *  transaction in the same response, so `normalizePayment`'s memo lookup
   *  resolves from data already in hand — one Horizon request per page, not
   *  one plus N. As a second line of defense (in case a given Horizon
   *  deployment doesn't honor the join), transaction fetches are additionally
   *  memoized per distinct `transaction_hash` for the duration of this call —
   *  several payments sharing one transaction only fetch it once. */
  async fetchSince(account: string, cursor: string, limit = 200): Promise<NormalizedPayment[]> {
    // join=transactions embeds the tx (and its memo) in the same response, so a
    // page of N payments costs one Horizon request instead of 1+N (issue #11).
    let builder = this.client
      .payments()
      .forAccount(account)
      .order("asc")
      .limit(limit)
      .join("transactions");
    if (cursor) builder = builder.cursor(cursor);

    let page;
    try {
      page = await withHorizonRetry(() => builder.call(), this.retryOptions);
      this.onOk();
    } catch (err) {
      if (isNotFound(err)) {
        this.onOk();
        return [];
      }
      this.onFail(err);
      throw err;
    }

    const txCache = new Map<string, Promise<Horizon.ServerApi.TransactionRecord>>();
    const fetchTransaction: FetchTransaction = (record: OperationWithTransaction) => {
      let pending = txCache.get(record.transaction_hash);
      if (!pending) {
        pending = record.transaction();
        txCache.set(record.transaction_hash, pending);
      }
      return pending;
    };

    // Deliberately not caught here: a transaction-fetch failure must not be
    // downgraded to a payment with no memo (that would silently park a
    // matchable payment as unmatched). Throwing lets the whole page fail, so
    // the caller's cursor doesn't advance and the next tick retries it.
    const out: NormalizedPayment[] = [];
    for (const record of page.records) {
      const normalized = await normalizePayment(record, fetchTransaction);
      if (normalized) out.push(normalized);
    }
    return out;
  }
}

function stringifyErr(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
