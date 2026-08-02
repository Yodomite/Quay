import type { Horizon } from "@stellar/stellar-sdk";
import { describe, expect, it, vi } from "vitest";
import { HorizonWatcher } from "../src/horizon-watcher";

function fakeRecord(hash: string, transaction: () => Promise<unknown>) {
  return {
    type: "payment",
    transaction_hash: hash,
    paging_token: `pt-${hash}`,
    created_at: "2026-01-01T00:00:00Z",
    to: "GTO",
    from: "GFROM",
    amount: "1",
    asset_type: "native",
    transaction,
  };
}

/** Fake Horizon.Server exposing just the payments() chain HorizonWatcher uses,
 *  recording whether/how `.join()` was called. */
function fakeServer(records: unknown[], joinSpy: (arg: string) => void) {
  const builder: any = {
    forAccount: () => builder,
    order: () => builder,
    limit: () => builder,
    cursor: () => builder,
    join: (arg: string) => {
      joinSpy(arg);
      return builder;
    },
    call: async () => ({ records }),
  };
  return { payments: () => builder } as unknown as Horizon.Server;
}

describe("HorizonWatcher.fetchSince", () => {
  it("requests join=transactions so the memo lookup costs zero extra Horizon calls", async () => {
    const joinSpy = vi.fn();
    const tx = vi.fn(async () => ({ memo: "m", memo_type: "text" }));
    const server = fakeServer([fakeRecord("h1", tx)], joinSpy);
    // The constructor accepts an injected client directly, so no network here.
    const watcher = new HorizonWatcher(server as any);

    await watcher.fetchSince("GACCOUNT", "");
    expect(joinSpy).toHaveBeenCalledWith("transactions");
  });

  it("fetches each distinct transaction_hash only once, even across multiple payment records", async () => {
    const tx1 = vi.fn(async () => ({ memo: "m1", memo_type: "text" }));
    const tx2 = vi.fn(async () => ({ memo: "m2", memo_type: "text" }));
    const records = [
      fakeRecord("h1", tx1),
      fakeRecord("h1", tx1), // same transaction, second operation record
      fakeRecord("h2", tx2),
    ];
    const server = fakeServer(records, vi.fn());
    const watcher = new HorizonWatcher(server as any);

    const result = await watcher.fetchSince("GACCOUNT", "");
    expect(result).toHaveLength(3);
    expect(tx1).toHaveBeenCalledTimes(1); // memoized despite two records sharing h1
    expect(tx2).toHaveBeenCalledTimes(1);
  });

  it("rejects the whole page (never returns partial/no_memo results) when a transaction fetch fails", async () => {
    const okTx = vi.fn(async () => ({ memo: "m", memo_type: "text" }));
    const failingTx = vi.fn(async () => {
      throw new Error("Horizon 503");
    });
    const records = [fakeRecord("h1", okTx), fakeRecord("h2", failingTx)];
    const server = fakeServer(records, vi.fn());
    const watcher = new HorizonWatcher(server as any);

    await expect(watcher.fetchSince("GACCOUNT", "")).rejects.toThrow("Horizon 503");
  });
});
