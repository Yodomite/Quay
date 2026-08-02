import type { Horizon } from "@stellar/stellar-sdk";
import { describe, expect, it, vi } from "vitest";
import { HorizonWatcher } from "../src/horizon-watcher";

// Minimal fake satisfying just the chain HorizonWatcher actually calls:
// client.payments().forAccount().order().limit()[.cursor()].join().call()
function fakeServer(call: () => Promise<{ records: unknown[] }>): Horizon.Server {
  const builder = {
    forAccount: () => builder,
    order: () => builder,
    limit: () => builder,
    cursor: () => builder,
    join: () => builder,
    call,
  };
  return { payments: () => builder } as unknown as Horizon.Server;
}

function errWithStatus(status: number) {
  return { response: { status } };
}

const FAST_RETRY = { baseDelayMs: 1, maxDelayMs: 1 };

describe("HorizonWatcher — degraded tracking + fallback", () => {
  it("treats a 404 as a normal answer, not a failure — stays not-degraded", async () => {
    const server = fakeServer(async () => {
      throw errWithStatus(404);
    });
    const watcher = new HorizonWatcher({ primaryServer: server, retryOptions: FAST_RETRY });

    const result = await watcher.latestCursor("GACCOUNT");
    expect(result).toBeNull();
    expect(watcher.getStatus()).toEqual({ degraded: false, usingFallback: false, consecutiveFailures: 0 });
  });

  it("resolves a 429-then-200 sequence transparently (retry policy wired through)", async () => {
    let calls = 0;
    const server = fakeServer(async () => {
      calls += 1;
      if (calls === 1) throw errWithStatus(429);
      return { records: [] };
    });
    const watcher = new HorizonWatcher({ primaryServer: server, retryOptions: FAST_RETRY });

    const result = await watcher.fetchSince("GACCOUNT", "");
    expect(result).toEqual([]);
    expect(watcher.getStatus().degraded).toBe(false);
    expect(calls).toBe(2);
  });

  it("marks degraded after `degradedThreshold` consecutive failed calls, and recovers on success", async () => {
    const server = fakeServer(async () => {
      throw errWithStatus(503);
    });
    const watcher = new HorizonWatcher({ primaryServer: server, degradedThreshold: 2, retryOptions: FAST_RETRY });

    await expect(watcher.fetchSince("GACCOUNT", "")).rejects.toBeTruthy();
    expect(watcher.getStatus()).toMatchObject({ degraded: false, consecutiveFailures: 1 });

    await expect(watcher.fetchSince("GACCOUNT", "")).rejects.toBeTruthy();
    expect(watcher.getStatus()).toMatchObject({ degraded: true, consecutiveFailures: 2 });
  });

  it("switches to the fallback server after the threshold, and back on recovery", async () => {
    let primaryCalls = 0;
    const primary = fakeServer(async () => {
      primaryCalls += 1;
      throw errWithStatus(503);
    });
    let fallbackCalls = 0;
    const fallback = fakeServer(async () => {
      fallbackCalls += 1;
      return { records: [] };
    });

    const watcher = new HorizonWatcher({
      primaryServer: primary,
      fallbackServer: fallback,
      degradedThreshold: 1,
      retryOptions: FAST_RETRY,
    });

    await expect(watcher.fetchSince("GACCOUNT", "")).rejects.toBeTruthy();
    expect(watcher.getStatus().usingFallback).toBe(true);

    // Next call should hit the fallback server, succeed, and reset back to primary.
    const result = await watcher.fetchSince("GACCOUNT", "");
    expect(result).toEqual([]);
    expect(fallbackCalls).toBeGreaterThan(0);
    expect(watcher.getStatus()).toEqual({ degraded: false, usingFallback: false, consecutiveFailures: 0 });
  });

  it("logs horizon_degraded and horizon_recovered", async () => {
    const log = vi.fn();
    let calls = 0;
    const server = fakeServer(async () => {
      calls += 1;
      if (calls === 1) throw errWithStatus(503); // first fetchSince call fails, second succeeds
      return { records: [] };
    });
    const watcher = new HorizonWatcher({ primaryServer: server, degradedThreshold: 1, retryOptions: { ...FAST_RETRY, maxAttempts: 1 }, log });

    await expect(watcher.fetchSince("GACCOUNT", "")).rejects.toBeTruthy();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("horizon_degraded"));

    await watcher.fetchSince("GACCOUNT", "");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("horizon_recovered"));
  });
});
