import type {
  AssetRef,
  OffRampJob,
  OffRampMode,
  OffRampPort,
  OffRampQuote,
  SellerPayoutRef,
} from "@checkout/core";
import { metrics } from "../metrics";

export type CircuitState = "closed" | "half_open" | "open";

const STATE_NUMBER: Record<CircuitState, number> = { closed: 0, half_open: 1, open: 2 };

export interface CircuitBreakerOptions {
  /** Consecutive failures before the circuit opens (default 3). */
  failureThreshold?: number;
  /** How long the circuit stays open before allowing a half-open trial call (default 30s). */
  cooldownMs?: number;
}

/**
 * Wraps an `OffRampPort` to (a) trip after repeated anchor failures so a down
 * anchor can't be hammered by every cash-out poll, and (b) instrument every
 * call — this is the one seam all off-ramp adapter calls pass through,
 * regardless of which SEPs the underlying adapter actually speaks.
 */
export class CircuitBreakerOffRamp implements OffRampPort {
  readonly mode: OffRampMode;

  private state: CircuitState = "closed";
  private consecutiveFailures = 0;
  private openedAt = 0;
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;

  constructor(
    private readonly inner: OffRampPort,
    opts: CircuitBreakerOptions = {},
  ) {
    this.mode = inner.mode;
    this.failureThreshold = opts.failureThreshold ?? 3;
    this.cooldownMs = opts.cooldownMs ?? 30_000;
  }

  getState(): CircuitState {
    return this.state;
  }

  getStateNumeric(): number {
    return STATE_NUMBER[this.state];
  }

  quote(input: {
    linkId: string;
    sourceAsset: AssetRef;
    sourceAmount: string;
    targetCurrency: string;
  }): Promise<OffRampQuote> {
    return this.call("quote", () => this.inner.quote(input));
  }

  initiate(input: { linkId: string; quoteId: string; payout: SellerPayoutRef }): Promise<OffRampJob> {
    return this.call("initiate", () => this.inner.initiate(input));
  }

  status(jobId: string): Promise<OffRampJob> {
    return this.call("status", () => this.inner.status(jobId));
  }

  private async call<T>(method: string, fn: () => Promise<T>): Promise<T> {
    if (this.state === "open") {
      if (Date.now() - this.openedAt < this.cooldownMs) {
        metrics.anchorCallsTotal.inc({ method, status: "error" });
        throw new Error(`off-ramp circuit open — anchor calls paused after repeated failures (method: ${method})`);
      }
      this.state = "half_open";
    }

    const start = Date.now();
    try {
      const result = await fn();
      metrics.anchorCallDurationSeconds.observe({ method }, (Date.now() - start) / 1000);
      metrics.anchorCallsTotal.inc({ method, status: "ok" });
      this.onSuccess();
      return result;
    } catch (err) {
      metrics.anchorCallDurationSeconds.observe({ method }, (Date.now() - start) / 1000);
      metrics.anchorCallsTotal.inc({ method, status: "error" });
      this.onFailure();
      throw err;
    }
  }

  private onSuccess(): void {
    this.consecutiveFailures = 0;
    this.state = "closed";
  }

  private onFailure(): void {
    this.consecutiveFailures += 1;
    if (this.state === "half_open" || this.consecutiveFailures >= this.failureThreshold) {
      this.state = "open";
      this.openedAt = Date.now();
    }
  }
}
