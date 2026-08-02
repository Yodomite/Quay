import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import { linkRoutes } from "../../src/routes/links";
import { rateLimit } from "../../src/middleware/rate-limit";
import { createTestContainer, type TestContainer } from "../setup";

// ---------------------------------------------------------------------------
//  Link route tests — exercised over Hono's app.request(), no network.
// ---------------------------------------------------------------------------

let container: TestContainer;
let app: Hono;

/** Every /links and /webhooks route is seller-gated since #79, so route tests
 *  authenticate as the default seller. `GET /links/:id` is public but sending
 *  the header there is harmless. */
let authToken = "";
async function req(path: string, init: RequestInit = {}): Promise<Response> {
  return app.request(path, {
    ...init,
    headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${authToken}` },
  });
}

beforeAll(async () => {
  container = await createTestContainer();
  app = new Hono();
  app.use("*", rateLimit({ windowMs: 60_000, max: 0 }));
  app.route("/links", linkRoutes(container, async (_c, next) => next()));
  const seller = await container.sellers.getDefault();
  authToken = await container.tokenFor(seller.id, seller.wallet);
});

afterAll(() => {
  container.client.close();
});

// ---------------------------------------------------------------------------
//  POST /links — create a payment link
// ---------------------------------------------------------------------------

describe("POST /links", () => {
  it("creates a link with valid body and returns 201", async () => {
    const res = await req("/links", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Test item", amount: "25.50", assetCode: "USDC" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as Record<string, unknown>;
    expect(body.link).toBeDefined();
    expect(body.request).toBeDefined();
    expect((body.link as Record<string, unknown>).id).toMatch(/^lnk_/);
    expect((body.link as Record<string, unknown>).status).toBe("active");
    expect((body.link as Record<string, unknown>).amount).toBe("25.5");
    expect((body.request as Record<string, unknown>).uri).toContain("web+stellar:pay");
  });

  it("creates a link with XLM asset", async () => {
    const res = await req("/links", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "XLM item", amount: "100", assetCode: "XLM" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as Record<string, unknown>;
    const link = body.link as Record<string, unknown>;
    expect((link.asset as Record<string, unknown>).code).toBe("XLM");
    expect((link.asset as Record<string, unknown>).issuer).toBeNull();
  });

  it("returns 400 for missing title", async () => {
    const res = await req("/links", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ amount: "10" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe("invalid_body");
  });

  it("returns 400 for invalid amount", async () => {
    const res = await req("/links", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Bad", amount: "-5" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 for empty title", async () => {
    const res = await req("/links", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "", amount: "10" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid JSON body", async () => {
    const res = await req("/links", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    expect(res.status).toBe(400);
  });

  it("creates a link with expiresInMinutes", async () => {
    const res = await req("/links", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Timed", amount: "10", expiresInMinutes: 60 }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as Record<string, unknown>;
    const link = body.link as Record<string, unknown>;
    expect(link.expiresAt).toBeTypeOf("number");
    expect((link.expiresAt as number)).toBeGreaterThan(Date.now());
  });
});

// ---------------------------------------------------------------------------
//  GET /links — list links
// ---------------------------------------------------------------------------

describe("GET /links", () => {
  it("returns an array of links", async () => {
    await req("/links", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "List test", amount: "50" }),
    });

    const res = await req("/links");
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(Array.isArray(body.links)).toBe(true);
    expect((body.links as Array<unknown>).length).toBeGreaterThanOrEqual(1);
  });

  it("returns links sorted newest-first", async () => {
    const res = await req("/links");
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    const links = body.links as Array<Record<string, unknown>>;
    if (links.length >= 2) {
      expect((links[0]!.createdAt as number)).toBeGreaterThanOrEqual(links[1]!.createdAt as number);
    }
  });
});

// ---------------------------------------------------------------------------
//  GET /links/:id — get single link
// ---------------------------------------------------------------------------

describe("GET /links/:id", () => {
  it("returns a link by id", async () => {
    const createRes = await req("/links", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Get me", amount: "30" }),
    });
    const created = await createRes.json() as Record<string, unknown>;
    const linkId = (created.link as Record<string, unknown>).id as string;

    const res = await req(`/links/${linkId}`);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect((body.link as Record<string, unknown>).id).toBe(linkId);
    expect(body.request).toBeDefined();
  });

  it("returns 404 for unknown id", async () => {
    const res = await req("/links/lnk_nonexistent");
    expect(res.status).toBe(404);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe("not_found");
  });
});

// ---------------------------------------------------------------------------
//  POST /links/:id/cash-out — trigger cash-out
// ---------------------------------------------------------------------------

describe("POST /links/:id/cash-out", () => {
  async function createAndPayLink(): Promise<string> {
    const createRes = await req("/links", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Cash-out test", amount: "10" }),
    });
    const created = await createRes.json() as Record<string, unknown>;
    const linkId = (created.link as Record<string, unknown>).id as string;

    const link = await container.links.findById(linkId);
    if (link) {
      link.status = "paid";
      link.txHash = `tx_cashout_${linkId}`;
      link.payer = "GBUYER";
      link.paidAmount = "10";
      await container.links.save(link);
    }
    return linkId;
  }

  it("returns 409 when link is not paid", async () => {
    const createRes = await req("/links", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Cash-out test", amount: "10" }),
    });
    const created = await createRes.json() as Record<string, unknown>;
    const linkId = (created.link as Record<string, unknown>).id as string;

    const res = await req(`/links/${linkId}/cash-out`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ targetCurrency: "NGN" }),
    });
    expect(res.status).toBe(409);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toContain("must be paid");
  });

  it("returns 404 when link does not exist", async () => {
    const res = await req("/links/lnk_nonexistent/cash-out", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ targetCurrency: "NGN" }),
    });
    expect(res.status).toBe(404);
  });

  // safeJson catches JSON parse errors and returns {}; cashOutSchema has defaults
  // so {} passes validation. Test schema failure with a non-conforming value instead.
  it("returns 400 when body field has wrong type", async () => {
    const linkId = await createAndPayLink();

    const res = await req(`/links/${linkId}/cash-out`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ targetCurrency: 123 }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe("invalid_body");
  });

  it("triggers cash-out successfully for a paid link", async () => {
    const linkId = await createAndPayLink();

    const res = await req(`/links/${linkId}/cash-out`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        targetCurrency: "NGN",
        payoutFields: { bank: "GTBank", account: "1234567890" },
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.job).toBeDefined();
    expect((body.job as Record<string, unknown>).status).toBe("pending");

    const updated = await container.links.findById(linkId);
    expect(updated?.status).toBe("offramp_pending");
    expect(updated?.offrampJobId).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
//  Rate-limit headers
// ---------------------------------------------------------------------------

describe("rate-limit headers", () => {
  it("includes x-ratelimit headers when rate limiter is active", async () => {
    const limitedApp = new Hono();
    limitedApp.use("*", rateLimit({ windowMs: 60_000, max: 5 }));
    limitedApp.route("/links", linkRoutes(container, async (_c, next) => next()));

    const res = await limitedApp.request("/links", { headers: { authorization: `Bearer ${authToken}` } });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-ratelimit-limit")).toBe("5");
    expect(res.headers.get("x-ratelimit-remaining")).toBe("4");
    expect(res.headers.get("x-ratelimit-reset")).toBeTruthy();
  });

  it("returns 429 when rate limit exceeded", async () => {
    const limitedApp = new Hono();
    limitedApp.use("*", rateLimit({ windowMs: 60_000, max: 1 }));
    limitedApp.route("/links", linkRoutes(container, async (_c, next) => next()));

    const res1 = await limitedApp.request("/links", { headers: { authorization: `Bearer ${authToken}` } });
    expect(res1.status).toBe(200);
    expect(res1.headers.get("x-ratelimit-remaining")).toBe("0");

    const res2 = await limitedApp.request("/links", { headers: { authorization: `Bearer ${authToken}` } });
    expect(res2.status).toBe(429);
    const body = await res2.json() as Record<string, unknown>;
    expect(body.error).toBe("rate_limited");
    expect(res2.headers.get("retry-after")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
//  404 fallback
// ---------------------------------------------------------------------------

describe("404 handling", () => {
  it("returns 404 for unknown routes", async () => {
    const res = await req("/nonexistent");
    expect(res.status).toBe(404);
  });
});
