// Retry policy for Horizon calls: 3 attempts (2 retries), exponential backoff
// with full jitter, honoring `Retry-After` on 429. Retryable vs terminal is
// decided purely from the error shape, so this has no Horizon-specific
// imports and is fully unit-testable offline.

export interface RetryOptions {
  /** Total attempts, including the first (default 3). */
  maxAttempts?: number;
  /** Base for exponential backoff in ms (default 200). */
  baseDelayMs?: number;
  /** Backoff ceiling in ms, before jitter (default 5000). */
  maxDelayMs?: number;
  /** Called before each retry sleep — for logging/metrics, never for control flow. */
  onRetry?: (attempt: number, err: unknown, delayMs: number) => void;
}

/** 400/404 (and other non-429 4xx) are terminal — the request itself is wrong
 *  or the resource doesn't exist, and retrying won't change that. 5xx, 429,
 *  and network-level failures (no HTTP response at all) are retryable. */
export function isRetryable(err: unknown): boolean {
  const status = (err as { response?: { status?: number } } | undefined)?.response?.status;
  if (status === undefined) return true; // network error, timeout, etc. — no response at all
  if (status === 429) return true;
  return status >= 500;
}

/** Reads `Retry-After` off an error's response headers, if present.
 *  Supports both the numeric-seconds and HTTP-date forms of the header. */
export function retryAfterMs(err: unknown): number | null {
  const headers = (err as { response?: { headers?: unknown } } | undefined)?.response?.headers;
  if (!headers) return null;

  const raw =
    typeof (headers as { get?: (k: string) => string | null }).get === "function"
      ? (headers as { get: (k: string) => string | null }).get("retry-after")
      : ((headers as Record<string, string>)["retry-after"] ?? (headers as Record<string, string>)["Retry-After"]);
  if (!raw) return null;

  const seconds = Number(raw);
  if (!Number.isNaN(seconds)) return Math.max(0, seconds * 1000);

  const atMs = Date.parse(raw);
  if (!Number.isNaN(atMs)) return Math.max(0, atMs - Date.now());

  return null;
}

/** Exponential backoff with *full* jitter: uniform random in [0, cap]. */
export function backoffWithFullJitter(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  const cap = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
  return Math.random() * cap;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Runs `fn`, retrying retryable failures with backoff. Terminal failures
 *  (and the final attempt's failure, whatever it was) are rethrown as-is —
 *  callers that special-case e.g. 404 keep working unchanged. */
export async function withHorizonRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 200;
  const maxDelayMs = opts.maxDelayMs ?? 5000;

  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= maxAttempts || !isRetryable(err)) throw err;
      const delay = retryAfterMs(err) ?? backoffWithFullJitter(attempt, baseDelayMs, maxDelayMs);
      opts.onRetry?.(attempt, err, delay);
      await sleep(delay);
    }
  }
}
