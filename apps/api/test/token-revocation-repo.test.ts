import { describe, expect, it } from "vitest";
import { createDb, bootstrap } from "../src/db/client";
import { DrizzleTokenRevocationRepository } from "../src/repos/index";

async function freshRepo() {
  const { db, client } = createDb(":memory:");
  await bootstrap(client);
  return new DrizzleTokenRevocationRepository(db);
}

describe("DrizzleTokenRevocationRepository", () => {
  it("reports a jti as not revoked until revoke() is called", async () => {
    const repo = await freshRepo();
    expect(await repo.isRevoked("jti-1")).toBe(false);

    await repo.revoke("jti-1", Math.floor(Date.now() / 1000) + 3600);
    expect(await repo.isRevoked("jti-1")).toBe(true);
  });

  it("revoking the same jti twice doesn't throw", async () => {
    const repo = await freshRepo();
    const exp = Math.floor(Date.now() / 1000) + 3600;
    await repo.revoke("jti-1", exp);
    await expect(repo.revoke("jti-1", exp)).resolves.not.toThrow();
  });

  it("sweepExpired removes only rows whose own exp has passed", async () => {
    const repo = await freshRepo();
    const now = Math.floor(Date.now() / 1000);
    await repo.revoke("expired", now - 10);
    await repo.revoke("still-valid", now + 3600);

    await repo.sweepExpired(now);

    expect(await repo.isRevoked("expired")).toBe(false);
    expect(await repo.isRevoked("still-valid")).toBe(true);
  });
});
