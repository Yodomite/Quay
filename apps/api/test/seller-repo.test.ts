import { describe, expect, it } from "vitest";
import { createDb, bootstrap } from "../src/db/client";
import { DrizzleSellerRepository } from "../src/repos/index";

async function freshRepo() {
  const { db, client } = createDb(":memory:");
  await bootstrap(client);
  return new DrizzleSellerRepository(db);
}

describe("DrizzleSellerRepository wallet-native signup", () => {
  it("createIfAbsent creates a seller keyed by wallet, then is idempotent", async () => {
    const repo = await freshRepo();
    const wallet = "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUV";

    const first = await repo.createIfAbsent(wallet);
    expect(first.wallet).toBe(wallet);

    const second = await repo.createIfAbsent(wallet);
    expect(second.id).toBe(first.id); // same seller, not a duplicate
  });

  it("findByWallet returns null for an unregistered wallet", async () => {
    const repo = await freshRepo();
    expect(await repo.findByWallet("GUNKNOWN")).toBeNull();
  });
});
