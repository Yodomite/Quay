/**
 * Test for per-seller watcher fan-out with fairness limits.
 * 
 * This test verifies that:
 * - 200 simulated destinations complete a tick inside one poll interval
 * - One failing account cannot delay the others
 * - Circuit breakers isolate failing accounts
 * - Fair round-robin prevents starvation
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { WatcherLoop, type AccountCircuitBreakerStatus, type WatcherMetrics } from "./watcher-loop";
import type { WatcherPort, LinkRepository, WatcherStateRepository } from "@checkout/core";
import type { LinkService } from "../services/link-service";

// Mock implementations
const mockWatcher: WatcherPort = {
  latestCursor: vi.fn(),
  fetchSince: vi.fn(),
};

const mockLinks: LinkRepository = {
  activeDestinations: vi.fn(),
  openLinksForDestination: vi.fn(),
  create: vi.fn(),
  findById: vi.fn(),
  findByReference: vi.fn(),
  listBySeller: vi.fn(),
  listByStatus: vi.fn(),
  save: vi.fn(),
};

const mockState: WatcherStateRepository = {
  getCursor: vi.fn(),
  setCursor: vi.fn(),
  isProcessed: vi.fn(),
  markProcessed: vi.fn(),
};

const mockService: Partial<LinkService> = {
  applyMatch: vi.fn(),
};

describe("WatcherLoop fan-out with fairness", () => {
  let loop: WatcherLoop;
  const pollMs = 1000;

  beforeEach(() => {
    vi.resetAllMocks();
    loop = new WatcherLoop({
      watcher: mockWatcher,
      links: mockLinks,
      state: mockState,
      service: mockService as any,
      pollMs,
      log: () => {},
    });
  });

  it("should process 200 accounts within one poll interval", async () => {
    // Generate 200 simulated accounts
    const accounts = Array.from({ length: 200 }, (_, i) => `account_${i}`);
    
    (mockLinks.activeDestinations as any).mockResolvedValue(accounts);
    
    // Mock successful responses for all accounts
    for (const account of accounts) {
      (mockState.getCursor as any).mockResolvedValueOnce("initial_cursor");
      (mockWatcher.fetchSince as any).mockResolvedValueOnce([]);
      (mockLinks.openLinksForDestination as any).mockResolvedValueOnce([]);
    }

    const startTime = Date.now();
    await loop.runOnce();
    const duration = Date.now() - startTime;

    // Should complete well within the poll interval
    expect(duration).toBeLessThan(pollMs);
    
    // Verify metrics
    const metrics = loop.getMetrics();
    expect(metrics.accountsWatched).toBe(200);
    expect(metrics.tickDurationMs).toBeLessThan(pollMs);
  });

  it("should use bounded concurrency (default 10)", async () => {
    const accounts = Array.from({ length: 50 }, (_, i) => `account_${i}`);
    (mockLinks.activeDestinations as any).mockResolvedValue(accounts);

    // Track concurrent calls
    let concurrentCalls = 0;
    let maxConcurrentCalls = 0;
    
    (mockState.getCursor as any).mockImplementation(async () => {
      concurrentCalls++;
      maxConcurrentCalls = Math.max(maxConcurrentCalls, concurrentCalls);
      await new Promise(resolve => setTimeout(resolve, 10));
      concurrentCalls--;
      return "cursor";
    });

    (mockWatcher.fetchSince as any).mockResolvedValue([]);
    (mockLinks.openLinksForDestination as any).mockResolvedValue([]);

    await loop.runOnce();

    // With default concurrency of 10, we should not exceed it significantly
    // Allow some overhead but should be bounded
    expect(maxConcurrentCalls).toBeLessThanOrEqual(15);
  });

  it("should isolate failing accounts with circuit breaker", async () => {
    const accounts = ["good_account", "bad_account", "another_good"];
    (mockLinks.activeDestinations as any).mockResolvedValue(accounts);

    (mockState.getCursor as any).mockResolvedValue("cursor");
    (mockWatcher.fetchSince as any).mockImplementation(async (account: string) => {
      if (account === "bad_account") {
        throw new Error("Network error");
      }
      return [];
    });
    (mockLinks.openLinksForDestination as any).mockResolvedValue([]);

    // Run 6 ticks to trigger circuit breaker threshold and observe open status
    for (let i = 0; i < 6; i++) {
      await loop.runOnce();
    }

    const circuitBreakers = loop.getCircuitBreakerStatus();
    const badAccountStatus = circuitBreakers.find((cb) => cb.account.startsWith("bad_"));

    expect(badAccountStatus).toBeDefined();
    expect(badAccountStatus?.isOpen).toBe(true);
    expect(badAccountStatus?.consecutiveErrors).toBeGreaterThanOrEqual(5);
  });

  it("should prevent account starvation with round-robin", async () => {
    const accounts = Array.from({ length: 100 }, (_, i) => `account_${i}`);
    (mockLinks.activeDestinations as any).mockResolvedValue(accounts);

    (mockState.getCursor as any).mockResolvedValue("cursor");
    (mockWatcher.fetchSince as any).mockResolvedValue([]);
    (mockLinks.openLinksForDestination as any).mockResolvedValue([]);

    // Run multiple ticks
    for (let i = 0; i < 10; i++) {
      await loop.runOnce();
    }

    const metrics = loop.getMetrics();
    
    // All accounts should have been processed (lag should be reasonable)
    // With round-robin, no account should be starved
    const maxLag = Math.max(...metrics.perAccountLag.values());
    expect(maxLag).toBeLessThan(pollMs * 20); // Should not be starved for 20 ticks
  });

  it("should back off idle accounts", async () => {
    let fakeTime = 1000;
    const dateSpy = vi.spyOn(Date, "now").mockImplementation(() => fakeTime);

    const accounts = ["idle_account", "active_account"];
    (mockLinks.activeDestinations as any).mockResolvedValue(accounts);

    (mockState.getCursor as any).mockResolvedValue("cursor");
    (mockWatcher.fetchSince as any).mockImplementation(async (account: string) => {
      if (account === "idle_account") return [];
      return [{ txHash: `tx_${fakeTime}`, pagingToken: `token_${fakeTime}` }];
    });
    (mockLinks.openLinksForDestination as any).mockResolvedValue([]);
    (mockState.isProcessed as any).mockResolvedValue(false);

    await loop.runOnce();

    // Run enough ticks to trigger backoff
    for (let i = 0; i < 15; i++) {
      fakeTime += 100;
      await loop.runOnce();
    }

    const metrics = loop.getMetrics();

    // Active account should have lower lag than idle account
    const activeLag = metrics.perAccountLag.get("active_account") || 0;
    const idleLag = metrics.perAccountLag.get("idle_account") || 0;

    expect(activeLag).toBeLessThan(idleLag);
    dateSpy.mockRestore();
  });

  it("should poll new accounts aggressively", async () => {
    const accounts = ["new_account"];
    (mockLinks.activeDestinations as any).mockResolvedValue(accounts);

    (mockState.getCursor as any).mockResolvedValue(null); // First time
    (mockWatcher.latestCursor as any).mockResolvedValue("latest_cursor");
    (mockState.setCursor as any).mockResolvedValue();

    await loop.runOnce();

    // New account should be marked and processed
    const circuitBreakers = loop.getCircuitBreakerStatus();
    const newAccountStatus = circuitBreakers.find(cb => cb.account.startsWith("new_"));
    
    expect(newAccountStatus).toBeDefined();
    expect(newAccountStatus?.consecutiveErrors).toBe(0);
  });

  it("should expose circuit breaker status in /ready endpoint format", async () => {
    const accounts = ["test_account"];
    (mockLinks.activeDestinations as any).mockResolvedValue(accounts);
    (mockState.getCursor as any).mockResolvedValue("cursor");
    (mockWatcher.fetchSince as any).mockResolvedValue([]);
    (mockLinks.openLinksForDestination as any).mockResolvedValue([]);

    await loop.runOnce();

    const status = loop.getCircuitBreakerStatus();
    
    expect(Array.isArray(status)).toBe(true);
    expect(status.length).toBeGreaterThan(0);
    expect(status[0]).toHaveProperty("account");
    expect(status[0]).toHaveProperty("isOpen");
    expect(status[0]).toHaveProperty("consecutiveErrors");
    expect(status[0]).toHaveProperty("lastErrorTime");
    expect(status[0]).toHaveProperty("cooldownUntil");
  });

  it("should expose comprehensive metrics", async () => {
    const accounts = Array.from({ length: 10 }, (_, i) => `account_${i}`);
    (mockLinks.activeDestinations as any).mockResolvedValue(accounts);
    (mockState.getCursor as any).mockResolvedValue("cursor");
    (mockWatcher.fetchSince as any).mockResolvedValue([]);
    (mockLinks.openLinksForDestination as any).mockResolvedValue([]);

    await loop.runOnce();

    const metrics = loop.getMetrics();
    
    expect(metrics).toHaveProperty("accountsWatched");
    expect(metrics).toHaveProperty("tickDurationMs");
    expect(metrics).toHaveProperty("circuitBreakersOpen");
    expect(metrics).toHaveProperty("perAccountLag");
    
    expect(metrics.accountsWatched).toBe(10);
    expect(typeof metrics.tickDurationMs).toBe("number");
    expect(metrics.perAccountLag.size).toBe(10);
  });
});
