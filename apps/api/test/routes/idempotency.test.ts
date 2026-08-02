import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import { linkRoutes } from "../../src/routes/links";
import { createTestContainer, type TestContainer } from "../setup";

// ---------------------------------------------------------------------------
//  Idempotency-Key behaviour (issue #26). The middleware sits after
//  requireSeller, so every request here is authenticated.
// ---------------------------------------------------------------------------

let container: TestContainer;
let app: Hono;
let token = "";

beforeAll(async () => {
  container = await createTestContainer();
  app = new Hono();
  app.route("/links", linkRoutes(container, async (_c, next) => next()));
  const seller = await container.sellers.getDefault();
  token = await container.tokenFor(seller.id, seller.wallet);
});

afterAll(() => {
  container.client.close();
});

function post(body: unknown, key?: string) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${token}`,
  };
  if (key) headers["idempotency-key"] = key;
  return app.request("/links", { method: "POST", headers, body: JSON.stringify(body) });
}

const LINK = { title: "Idempotent item", amount: "10", assetCode: "USDC" as const };

describe("Idempotency-Key on POST /links", () => {
  it("still creates normally when no key is supplied", async () => {
    const res = await post(LINK);
    expect(res.status).toBe(201);
  });

  it("replays a byte-identical response for the same key + same body", async () => {
    const first = await post(LINK, "key-replay-1");
    expect(first.status).toBe(201);
    const firstBody = await first.text();

    const second = await post(LINK, "key-replay-1");
    expect(second.status).toBe(201);
    expect(await second.text()).toBe(firstBody); // byte-identical
    expect(second.headers.get("idempotent-replayed")).toBe("true");
  });

  it("does not create a second link when replayed", async () => {
    await post(LINK, "key-once-1");
    const before = (await container.links.listBySeller((await container.sellers.getDefault()).id)).length;
    await post(LINK, "key-once-1");
    const after = (await container.links.listBySeller((await container.sellers.getDefault()).id)).length;
    expect(after).toBe(before);
  });

  it("rejects the same key with a different body — 409 idempotency_key_reuse", async () => {
    await post(LINK, "key-reuse-1");
    const res = await post({ ...LINK, amount: "999" }, "key-reuse-1");
    expect(res.status).toBe(409);
    expect(((await res.json()) as Record<string, unknown>).error).toBe("idempotency_key_reuse");
  });

  it("treats distinct keys as distinct requests", async () => {
    const a = await post(LINK, "key-distinct-a");
    const b = await post(LINK, "key-distinct-b");
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    const idA = ((await a.json()) as { link: { id: string } }).link.id;
    const idB = ((await b.json()) as { link: { id: string } }).link.id;
    expect(idA).not.toBe(idB);
  });
});
