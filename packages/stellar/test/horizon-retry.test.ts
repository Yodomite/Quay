import { describe, expect, it, vi } from "vitest";
import { backoffWithFullJitter, isRetryable, retryAfterMs, withHorizonRetry } from "../src/horizon-retry";

function errWithStatus(status: number, headers?: Record<string, string>) {
  return { response: { status, headers } };
}

describe("isRetryable", () => {
  it("treats 5xx as retryable", () => {
    expect(isRetryable(errWithStatus(500))).toBe(true);
    expect(isRetryable(errWithStatus(503))).toBe(true);
  });

  it("treats 429 as retryable", () => {
    expect(isRetryable(errWithStatus(429))).toBe(true);
  });

  it("treats 404 and other 4xx as terminal", () => {
    expect(isRetryable(errWithStatus(404))).toBe(false);
    expect(isRetryable(errWithStatus(400))).toBe(false);
  });

  it("treats a bare network error (no response) as retryable", () => {
    expect(isRetryable(new Error("ECONNRESET"))).toBe(true);
  });
});

describe("retryAfterMs", () => {
  it("reads a numeric-seconds Retry-After header", () => {
    expect(retryAfterMs(errWithStatus(429, { "retry-after": "2" }))).toBe(2000);
  });

  it("returns null when there's no Retry-After header", () => {
    expect(retryAfterMs(errWithStatus(429))).toBeNull();
  });

  it("returns null for a non-response error", () => {
    expect(retryAfterMs(new Error("x"))).toBeNull();
  });
});

describe("backoffWithFullJitter", () => {
  it("stays within [0, cap] and respects the ceiling", () => {
    for (let attempt = 1; attempt <= 6; attempt++) {
      const delay = backoffWithFullJitter(attempt, 100, 1000);
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThanOrEqual(1000);
    }
  });
});

describe("withHorizonRetry", () => {
  it("resolves without a caller-visible error on a 429-then-200 sequence", async () => {
    let calls = 0;
    const fn = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw errWithStatus(429, { "retry-after": "0" });
      return "ok";
    });

    const result = await withHorizonRetry(fn, { baseDelayMs: 1, maxDelayMs: 1 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("gives up after maxAttempts and rethrows the last error", async () => {
    const fn = vi.fn(async () => {
      throw errWithStatus(503);
    });

    await expect(withHorizonRetry(fn, { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1 })).rejects.toMatchObject({
      response: { status: 503 },
    });
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("never retries a terminal 404 — the fast path stays fast", async () => {
    const fn = vi.fn(async () => {
      throw errWithStatus(404);
    });

    await expect(withHorizonRetry(fn, { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1 })).rejects.toMatchObject({
      response: { status: 404 },
    });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("calls onRetry with the attempt number and computed delay", async () => {
    let calls = 0;
    const fn = vi.fn(async () => {
      calls += 1;
      if (calls < 2) throw errWithStatus(500);
      return "ok";
    });
    const onRetry = vi.fn();

    await withHorizonRetry(fn, { baseDelayMs: 1, maxDelayMs: 1, onRetry });
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry.mock.calls[0]![0]).toBe(1); // attempt 1 failed, about to retry
  });
});
