import { describe, expect, it, vi } from "vitest";
import type { OffRampJob, OffRampPort, OffRampQuote } from "@checkout/core";
import { CircuitBreakerOffRamp } from "../src/services/circuit-breaker";

const fakeQuote: OffRampQuote = {
  quoteId: "q1",
  sourceAsset: { code: "USDC", issuer: "G" },
  sourceAmount: "1",
  targetCurrency: "USD",
  targetAmount: "1",
  rate: "1",
  expiresAt: Date.now() + 60_000,
};

const fakeJob: OffRampJob = {
  jobId: "j1",
  linkId: "lnk_1",
  status: "pending",
  targetCurrency: "USD",
  targetAmount: "1",
  rate: "1",
};

function fakePort(overrides: Partial<OffRampPort> = {}): OffRampPort {
  return {
    mode: "seller_initiated",
    quote: vi.fn(async () => fakeQuote),
    initiate: vi.fn(async () => fakeJob),
    status: vi.fn(async () => fakeJob),
    ...overrides,
  };
}

describe("CircuitBreakerOffRamp", () => {
  it("passes calls through and stays closed while the adapter succeeds", async () => {
    const inner = fakePort();
    const breaker = new CircuitBreakerOffRamp(inner);

    await breaker.quote({ linkId: "lnk_1", sourceAsset: { code: "USDC", issuer: "G" }, sourceAmount: "1", targetCurrency: "USD" });
    expect(breaker.getState()).toBe("closed");
    expect(inner.quote).toHaveBeenCalledTimes(1);
  });

  it("opens after the failure threshold and short-circuits further calls without touching the adapter", async () => {
    const status = vi.fn(async () => {
      throw new Error("anchor down");
    });
    const inner = fakePort({ status });
    const breaker = new CircuitBreakerOffRamp(inner, { failureThreshold: 2, cooldownMs: 60_000 });

    await expect(breaker.status("j1")).rejects.toThrow("anchor down");
    expect(breaker.getState()).toBe("closed"); // 1st failure, not yet at threshold
    await expect(breaker.status("j1")).rejects.toThrow("anchor down");
    expect(breaker.getState()).toBe("open"); // 2nd failure hits threshold

    await expect(breaker.status("j1")).rejects.toThrow(/circuit open/);
    expect(status).toHaveBeenCalledTimes(2); // 3rd call never reached the adapter
  });

  it("closes again after a successful half-open trial past the cooldown", async () => {
    let shouldFail = true;
    const status = vi.fn(async () => {
      if (shouldFail) throw new Error("down");
      return { ...fakeJob, status: "settled" as const };
    });
    const inner = fakePort({ status });
    const breaker = new CircuitBreakerOffRamp(inner, { failureThreshold: 1, cooldownMs: 10 });

    await expect(breaker.status("j1")).rejects.toThrow();
    expect(breaker.getState()).toBe("open");

    await new Promise((r) => setTimeout(r, 20)); // past cooldown
    shouldFail = false;
    const result = await breaker.status("j1");
    expect(result.status).toBe("settled");
    expect(breaker.getState()).toBe("closed");
  });

  it("getStateNumeric reflects closed=0, open=2", async () => {
    const inner = fakePort({
      quote: vi.fn(async () => {
        throw new Error("x");
      }),
    });
    const breaker = new CircuitBreakerOffRamp(inner, { failureThreshold: 1 });
    expect(breaker.getStateNumeric()).toBe(0);
    await expect(breaker.quote({ linkId: "lnk_1", sourceAsset: { code: "USDC", issuer: "G" }, sourceAmount: "1", targetCurrency: "USD" })).rejects.toThrow();
    expect(breaker.getStateNumeric()).toBe(2);
  });
});
