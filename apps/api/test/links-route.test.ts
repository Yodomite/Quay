import { describe, expect, it } from "vitest";
import type { PaymentLink, Seller, SellerRepository, TokenRevocationRepository } from "@checkout/core";
import type { Container } from "../src/services/container";
import { SessionIssuer } from "../src/services/session";
import { linkRoutes } from "../src/routes/links";

const owner: Seller = { id: "sel_owner", name: "Owner", wallet: "GOWNER", createdAt: Date.now() };
const other: Seller = { id: "sel_other", name: "Other", wallet: "GOTHER", createdAt: Date.now() };

const ownedLink: PaymentLink = {
  id: "lnk_1",
  reference: "ref_1",
  sellerId: owner.id,
  destination: owner.wallet,
  muxedId: null,
  title: "T-shirt",
  amount: "10",
  asset: { code: "USDC", issuer: "GISSUER" },
  status: "active",
  txHash: null,
  payer: null,
  paidAmount: null,
  offrampJobId: null,
  offrampTargetCurrency: null,
  offrampStatus: null,
  expiresAt: null,
  createdAt: Date.now(),
  updatedAt: Date.now(),
};

function fakeContainer(): Container {
  const sellersById = new Map([[owner.id, owner], [other.id, other]]);
  const sellers: SellerRepository = {
    getDefault: async () => owner,
    findById: async (id) => sellersById.get(id) ?? null,
    findByWallet: async () => null,
    createIfAbsent: async () => owner,
  };
  const revocations: TokenRevocationRepository = {
    revoke: async () => {},
    isRevoked: async () => false,
    sweepExpired: async () => {},
  };
  const session = new SessionIssuer("test-secret");

  return {
    service: {
      getLink: async (id: string) => (id === ownedLink.id ? { link: ownedLink, request: {} as any } : null),
      createLink: async () => ({ link: ownedLink, request: {} as any }),
      listLinks: async () => [ownedLink],
      cancelLink: async () => ({ ...ownedLink, status: "cancelled" as const }),
    } as unknown as Container["service"],
    links: {} as Container["links"],
    sellers: sellers as unknown as Container["sellers"],
    webhooks: {} as Container["webhooks"],
    config: { network: "testnet", horizonUrl: "https://horizon-testnet.stellar.org", sellerWallet: owner.wallet },
    auth: { session, sellers, revocations } as unknown as Container["auth"],
    kyc: {} as Container["kyc"],
    db: {} as Container["db"],
    horizonStatus: () => ({ degraded: false, usingFallback: false, consecutiveFailures: 0 }),
    metricsToken: "test-metrics-token",
    watcherLagSeconds: () => 0,
    circuitBreakerState: () => 0,
    getWatcherCircuitBreakerStatus: () => [],
    getWatcherMetrics: () => ({
      accountsWatched: 0,
      tickDurationMs: 0,
      perAccountLag: new Map(),
      circuitBreakersOpen: 0,
    }),
    start() {},
    stop() {},
  };
}

async function tokenFor(session: SessionIssuer, sellerId: string): Promise<string> {
  const { token } = await session.issue({ sub: "GSUB", sellerId });
  return token;
}

describe("GET /links/:id — public checkout read", () => {
  // Deliberately NOT gated: the buyer paying an invoice holds no seller session,
  // and the checkout page is server-rendered with no cookie at all. The link id
  // is the bearer capability here.
  it("returns the link (200) to an unauthenticated buyer", async () => {
    const container = fakeContainer();
    const app = linkRoutes(container, async (_c, next) => next());
    const res = await app.request(`/${ownedLink.id}`);
    expect(res.status).toBe(200);
  });

  it("returns the link (200) when the owning seller is authenticated", async () => {
    const container = fakeContainer();
    const app = linkRoutes(container, async (_c, next) => next());
    const token = await tokenFor(container.auth.session, owner.id);

    const res = await app.request(`/${ownedLink.id}`, { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
  });

  it("still serves a link to a different authenticated seller — reads are public", async () => {
    const container = fakeContainer();
    const app = linkRoutes(container, async (_c, next) => next());
    const token = await tokenFor(container.auth.session, other.id);

    const res = await app.request(`/${ownedLink.id}`, { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
  });

  it("returns 404 for a nonexistent link", async () => {
    const container = fakeContainer();
    const app = linkRoutes(container, async (_c, next) => next());
    const res = await app.request(`/lnk_does_not_exist`);
    expect(res.status).toBe(404);
  });
});

describe("POST /links/:id/cancel — ownership", () => {
  it("rejects with 401 when no token is provided", async () => {
    const app = linkRoutes(fakeContainer(), async (_c, next) => next());
    const res = await app.request(`/${ownedLink.id}/cancel`, { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("rejects with 403 when a different seller tries to cancel the link", async () => {
    const container = fakeContainer();
    const app = linkRoutes(container, async (_c, next) => next());
    const token = await tokenFor(container.auth.session, other.id);

    const res = await app.request(`/${ownedLink.id}/cancel`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as Record<string, unknown>).error).toBe("forbidden");
  });

  it("cancels the link for its owner", async () => {
    const container = fakeContainer();
    const app = linkRoutes(container, async (_c, next) => next());
    const token = await tokenFor(container.auth.session, owner.id);

    const res = await app.request(`/${ownedLink.id}/cancel`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
  });
});
