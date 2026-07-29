import { describe, expect, it } from "vitest";
import type { WatcherPort } from "@checkout/core";
import { FakeHorizonClient } from "./fake-horizon";

const ACCOUNT = "GDEST0000000000000000000000000000000000000000000000000000";

export interface WatcherHarness {
  fake: FakeHorizonClient;
  watcher: WatcherPort;
  /** No-op for implementations with no persistent connection (e.g. polling). */
  killConnection?: (account: string) => void;
}

/**
 * Same assertions run against every WatcherPort implementation. A conforming
 * implementation must satisfy `fetchSince` semantics identically regardless
 * of how it sources data from Horizon underneath.
 */
export function runWatcherContract(name: string, makeHarness: () => WatcherHarness): void {
  describe(`WatcherPort contract: ${name}`, () => {
    it("latestCursor is null for an account with no payments", async () => {
      const { watcher } = makeHarness();
      expect(await watcher.latestCursor(ACCOUNT)).toBeNull();
    });

    it("latestCursor is null for an account not yet created on-chain", async () => {
      const { fake, watcher } = makeHarness();
      fake.markNotFound(ACCOUNT);
      expect(await watcher.latestCursor(ACCOUNT)).toBeNull();
    });

    it("latestCursor reflects the newest payment token", async () => {
      const { fake, watcher } = makeHarness();
      fake.addPayment({ account: ACCOUNT, memo: "ref_1" });
      const second = fake.addPayment({ account: ACCOUNT, memo: "ref_2" });
      expect(await watcher.latestCursor(ACCOUNT)).toBe(second.paging_token);
    });

    it("fetchSince returns nothing before any payment lands", async () => {
      const { watcher } = makeHarness();
      expect(await watcher.fetchSince(ACCOUNT, "")).toEqual([]);
    });

    it("fetchSince delivers new payments, oldest-first, normalized", async () => {
      const { fake, watcher } = makeHarness();
      fake.addPayment({ account: ACCOUNT, from: "GBUYER1", amount: "10", memo: "ref_1" });
      fake.addPayment({ account: ACCOUNT, from: "GBUYER2", amount: "20", memo: "ref_2" });

      const payments = await watcher.fetchSince(ACCOUNT, "");
      expect(payments.map((p) => p.memo)).toEqual(["ref_1", "ref_2"]);
      expect(payments[0]).toMatchObject({ from: "GBUYER1", amount: "10", to: ACCOUNT });
      expect(payments[1]).toMatchObject({ from: "GBUYER2", amount: "20", to: ACCOUNT });
    });

    it("filters out non-value operations", async () => {
      const { fake, watcher } = makeHarness();
      fake.addPayment({ account: ACCOUNT, type: "create_account", memo: null });
      fake.addPayment({ account: ACCOUNT, memo: "ref_1" });

      const payments = await watcher.fetchSince(ACCOUNT, "");
      expect(payments.map((p) => p.memo)).toEqual(["ref_1"]);
    });

    it("never redelivers a payment once the cursor has advanced past it", async () => {
      const { fake, watcher } = makeHarness();
      fake.addPayment({ account: ACCOUNT, memo: "ref_1" });
      const first = await watcher.fetchSince(ACCOUNT, "");
      expect(first).toHaveLength(1);
      const cursor = first[0]!.pagingToken;

      const second = await watcher.fetchSince(ACCOUNT, cursor);
      expect(second).toEqual([]);

      fake.addPayment({ account: ACCOUNT, memo: "ref_2" });
      const third = await watcher.fetchSince(ACCOUNT, cursor);
      expect(third.map((p) => p.memo)).toEqual(["ref_2"]);
    });

    it("keeps accounts independent", async () => {
      const { fake, watcher } = makeHarness();
      const other = "GOTHER00000000000000000000000000000000000000000000000000";
      fake.addPayment({ account: ACCOUNT, memo: "mine" });
      fake.addPayment({ account: other, memo: "not_mine" });

      const payments = await watcher.fetchSince(ACCOUNT, "");
      expect(payments.map((p) => p.memo)).toEqual(["mine"]);
    });

    it("survives a dropped connection without duplicating or dropping a payment", async () => {
      const { fake, watcher, killConnection } = makeHarness();
      fake.addPayment({ account: ACCOUNT, memo: "ref_1" });
      const first = await watcher.fetchSince(ACCOUNT, "");
      const cursor = first[first.length - 1]!.pagingToken;

      killConnection?.(ACCOUNT);
      // Payments that land during/after the interruption must still surface,
      // exactly once, once the implementation has had a chance to recover.
      fake.addPayment({ account: ACCOUNT, memo: "ref_2" });
      const observed = await pollUntil(
        () => watcher.fetchSince(ACCOUNT, cursor),
        (payments) => payments.length > 0,
      );
      expect(observed.map((p) => p.memo)).toEqual(["ref_2"]);

      const again = await watcher.fetchSince(ACCOUNT, observed[observed.length - 1]!.pagingToken);
      expect(again).toEqual([]);
    });
  });
}

async function pollUntil<T>(fn: () => Promise<T>, done: (v: T) => boolean, timeoutMs = 2000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (done(v)) return v;
    if (Date.now() - start > timeoutMs) return v;
    await new Promise((r) => setTimeout(r, 10));
  }
}
