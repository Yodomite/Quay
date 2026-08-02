import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { Seller, SellerRepository, TokenRevocationRepository } from "@checkout/core";
import { SessionIssuer } from "../src/services/session";
import { requireSeller, type AuthedVariables } from "../src/middleware/auth";

const seller: Seller = { id: "sel_1", name: "Demo", wallet: "GWALLET", createdAt: Date.now() };

function fakeSellers(knownSeller: Seller | null = seller): SellerRepository {
  return {
    getDefault: async () => seller,
    findById: async (id) => (knownSeller && knownSeller.id === id ? knownSeller : null),
    findByWallet: async () => knownSeller,
    createIfAbsent: async () => seller,
  };
}

function fakeRevocations(revokedJtis: Set<string> = new Set()): TokenRevocationRepository {
  return {
    revoke: async (jti) => {
      revokedJtis.add(jti);
    },
    isRevoked: async (jti) => revokedJtis.has(jti),
    sweepExpired: async () => {},
  };
}

function buildApp(deps: { session: SessionIssuer; sellers: SellerRepository; revocations: TokenRevocationRepository }) {
  const app = new Hono<{ Variables: AuthedVariables }>();
  app.use("*", requireSeller(deps));
  app.get("/protected", (ctx) => ctx.json({ sellerId: ctx.get("seller").id, jti: ctx.get("jti") }));
  return app;
}

describe("requireSeller", () => {
  it("rejects a request with no token — 401", async () => {
    const app = buildApp({ session: new SessionIssuer("s"), sellers: fakeSellers(), revocations: fakeRevocations() });
    const res = await app.request("/protected");
    expect(res.status).toBe(401);
    expect(((await res.json()) as Record<string, unknown>).error).toBe("unauthorized");
  });

  it("rejects a tampered token — 401", async () => {
    const session = new SessionIssuer("s");
    const issued = await session.issue({ sub: "G1", sellerId: "sel_1" });
    const tampered = issued.token.slice(0, -2) + "xx";

    const app = buildApp({ session, sellers: fakeSellers(), revocations: fakeRevocations() });
    const res = await app.request("/protected", { headers: { authorization: `Bearer ${tampered}` } });
    expect(res.status).toBe(401);
  });

  it("rejects an expired token — 401", async () => {
    const session = new SessionIssuer("s", -1);
    const issued = await session.issue({ sub: "G1", sellerId: "sel_1" });

    const app = buildApp({ session, sellers: fakeSellers(), revocations: fakeRevocations() });
    const res = await app.request("/protected", { headers: { authorization: `Bearer ${issued.token}` } });
    expect(res.status).toBe(401);
  });

  it("rejects a revoked token — 401", async () => {
    const session = new SessionIssuer("s");
    const issued = await session.issue({ sub: "G1", sellerId: "sel_1" });
    const revocations = fakeRevocations(new Set([issued.jti]));

    const app = buildApp({ session, sellers: fakeSellers(), revocations });
    const res = await app.request("/protected", { headers: { authorization: `Bearer ${issued.token}` } });
    expect(res.status).toBe(401);
    expect(((await res.json()) as Record<string, unknown>).message).toMatch(/revoked/);
  });

  it("rejects a token for a seller that no longer exists — 401", async () => {
    const session = new SessionIssuer("s");
    const issued = await session.issue({ sub: "G1", sellerId: "sel_1" });

    const app = buildApp({ session, sellers: fakeSellers(null), revocations: fakeRevocations() });
    const res = await app.request("/protected", { headers: { authorization: `Bearer ${issued.token}` } });
    expect(res.status).toBe(401);
  });

  it("accepts a valid bearer token and exposes seller + jti on context", async () => {
    const session = new SessionIssuer("s");
    const issued = await session.issue({ sub: "G1", sellerId: "sel_1" });

    const app = buildApp({ session, sellers: fakeSellers(), revocations: fakeRevocations() });
    const res = await app.request("/protected", { headers: { authorization: `Bearer ${issued.token}` } });
    expect(res.status).toBe(200);
    expect((await res.json()) as Record<string, unknown>).toEqual({ sellerId: "sel_1", jti: issued.jti });
  });

  it("also accepts the token via the session cookie (SSR path)", async () => {
    const session = new SessionIssuer("s");
    const issued = await session.issue({ sub: "G1", sellerId: "sel_1" });

    const app = buildApp({ session, sellers: fakeSellers(), revocations: fakeRevocations() });
    const res = await app.request("/protected", { headers: { cookie: `session=${issued.token}` } });
    expect(res.status).toBe(200);
  });
});
