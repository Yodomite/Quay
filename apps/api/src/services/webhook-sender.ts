import { createHmac } from "node:crypto";
import type { Webhook, WebhookRepository } from "@checkout/core";
import { metrics } from "../metrics";

export interface WebhookEvent {
  event: string; // e.g. "link.paid"
  data: Record<string, unknown>;
}

export interface WebhookSenderOptions {
  /** Total delivery attempts per hook before giving up (default 4). */
  maxAttempts?: number;
  /** Base backoff in ms; doubles each retry, with jitter (default 500). */
  baseDelayMs?: number;
  /** Per-request timeout in ms (default 8000). */
  timeoutMs?: number;
}

/**
 * Delivers events to a seller's registered webhooks. The body is signed with
 * HMAC-SHA256 using the per-webhook secret, sent as `X-Checkout-Signature`.
 * Receivers verify by recomputing the HMAC over the exact raw body, and should
 * reject events whose in-body `sentAt` is too old (replay protection — `sentAt`
 * is inside the signed body, so it cannot be tampered with).
 *
 * Delivery is retried with exponential backoff on transient failures (network
 * errors and 5xx / 429 responses). 4xx (other than 429) is treated as a
 * permanent failure and not retried. Only the final outcome is recorded.
 *
 * NOTE: retries are in-process — a crash mid-backoff loses pending retries.
 * A durable queue is the production answer; this hardens the common transient case.
 */
export class WebhookSender {
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly timeoutMs: number;
  private inFlight = 0;

  constructor(
    private readonly repo: WebhookRepository,
    opts: WebhookSenderOptions = {},
  ) {
    this.maxAttempts = Math.max(1, opts.maxAttempts ?? 4);
    this.baseDelayMs = opts.baseDelayMs ?? 500;
    this.timeoutMs = opts.timeoutMs ?? 8000;
  }

  /** Deliveries currently in progress, including in-process retry backoff. */
  get inFlightCount(): number {
    return this.inFlight;
  }

  async dispatch(hooks: Webhook[], linkId: string, event: WebhookEvent): Promise<void> {
    const body = JSON.stringify({ ...event, id: linkId, sentAt: new Date().toISOString() });

    await Promise.all(hooks.map((hook) => this.deliver(hook, linkId, event.event, body)));
  }

  private async deliver(
    hook: Webhook,
    linkId: string,
    event: string,
    body: string,
  ): Promise<void> {
    const signature = createHmac("sha256", hook.secret).update(body).digest("hex");

    let statusCode: number | null = null;
    let error: string | null = null;

    this.inFlight += 1;
    try {
      for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
        try {
          const res = await fetch(hook.url, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-checkout-signature": `sha256=${signature}`,
              "x-checkout-event": event,
            },
            body,
            signal: AbortSignal.timeout(this.timeoutMs),
          });

          if (res.ok) {
            metrics.webhookAttemptsTotal.inc({ result: "ok" });
            await this.repo.recordDelivery({ webhookId: hook.id, linkId, event, statusCode: res.status, ok: true, error: null });
            return;
          }

          metrics.webhookAttemptsTotal.inc({ result: "error" });
          statusCode = res.status;
          error = `HTTP ${res.status}`;
          // 4xx (except 429) is a client error the receiver won't fix on retry.
          if (res.status < 500 && res.status !== 429) break;
        } catch (err) {
          metrics.webhookAttemptsTotal.inc({ result: "error" });
          statusCode = null;
          error = err instanceof Error ? err.message : String(err);
        }

        if (attempt < this.maxAttempts) await sleep(this.backoff(attempt));
      }

      await this.repo.recordDelivery({ webhookId: hook.id, linkId, event, statusCode, ok: false, error });
    } finally {
      this.inFlight -= 1;
    }
  }

  /** Exponential backoff with full jitter. */
  private backoff(attempt: number): number {
    const ceiling = this.baseDelayMs * 2 ** (attempt - 1);
    return Math.floor(Math.random() * ceiling);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
