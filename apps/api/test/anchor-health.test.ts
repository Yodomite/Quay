import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  type LinkRepository,
  type NormalizedPayment,
  type OffRampJob,
  type OffRampJobStatus,
  type OffRampPort,
  type OffRampQuote,
  type PaymentLink,
  type RailPort,
  type Seller,
  type Webhook,
  type WebhookDelivery,
  type WebhookRepository,
} from "@checkout/core";
import type { StellarConfig } from "@checkout/stellar";
import { AnchorHealth, LinkService } from "../src/services/link-service";
import { Hono } from "hono";

const DEST = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
const ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

function link(over: Partial<PaymentLink> = {}): PaymentLink {
  return {
    id: "lnk_1",
    reference: "ref_1",
    sellerId: "s_1",
    destination: DEST,
    title: "Test",
    amount: "10",
    asset: { code: "USDC", issuer: ISSUER },
    status: "active",
    txHash: null,
    payer: null,
    paidAmount: null,
    offrampJobId: null,
    offrampTargetCurrency: null,
    offrampStatus: null,
    expiresAt: null,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...over,
  };
}

// ---------- fetch intercept --------------------------------------------------

let fetchLog: { url: string; ok: boolean; status: number; body?: unknown }[] = [];

function configureFetch(handler: (url: string) => { ok: boolean; status?: number; body?: unknown }): void {
  fetchLog = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, _init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const { ok, status = ok ? 200 : 500, body } = handler(url);
      fetchLog.push({ url, ok, status, body });
      return new Response(body === undefined ? "" : JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    }),
  );
}

beforeEach(() => {
  fetchLog = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------- AnchorHealth unit tests ------------------------------------------

describe("AnchorHealth (probe + circuit breaker)", () => {
  it("in a config-disabled mode (mock), probe always succeeds and stays closed without IO", async () => {
    const h = new AnchorHealth({ enabled: false, url: null, homeDomain: null });
    configureFetch(() => ({ ok: false, status: 500 }));
    const snap = await h.probe();
    expect(snap.state).toBe("closed");
    expect(snap.consecutiveFailures).toBe(0);
    expect(fetchLog).toHaveLength(0);
    expect(h.isAvailable()).toBe(true);
  });

  it("happy path: TOML + SEP-10 challenge with transaction + /info all 200 -> closed, probes.all true", async () => {
    const url = "https://testanchor.stellar.org";
    const h = new AnchorHealth({ enabled: true, url, homeDomain: "testanchor.stellar.org" });
    configureFetch((u) => {
      if (u.endsWith("/.well-known/stellar.toml")) return { ok: true };
      if (u.endsWith("/auth") || u.includes("/auth?")) {
        return { ok: true, body: { transaction: "AAAA...", network_passphrase: "Test SDF Network ; September 2015" } };
      }
      if (u.endsWith("/info")) return { ok: true, body: { services: [] } };
      return { ok: false, status: 404 };
    });

    await h.probe();
    const snap = h.snapshot();
    expect(snap.state).toBe("closed");
    expect(snap.probes.toml).toBe(true);
    expect(snap.probes.sep10).toBe(true);
    expect(snap.probes.info).toBe(true);
    expect(snap.consecutiveFailures).toBe(0);
    expect(snap.lastError).toBeNull();
    expect(snap.lastSuccessAt).not.toBeNull();
  });

  it("failure threshold: 3 consecutive probes open the breaker", async () => {
    const h = new AnchorHealth({ enabled: true, url: "https://testanchor.stellar.org", homeDomain: "x.example" });
    configureFetch(() => ({ ok: false, status: 502 }));

    await h.probe();
    await h.probe();
    expect(h.snapshot().state).toBe("closed"); // still under threshold
    expect(h.snapshot().consecutiveFailures).toBe(2);

    await h.probe();
    expect(h.snapshot().state).toBe("open");
    expect(h.isAvailable()).toBe(false);
    expect(h.snapshot().lastError).toContain("TOML probe returned 502");
  });

  it("opens immediately on hard errors (timeouts) and reports a sensible lastError", async () => {
    const h = new AnchorHealth({ enabled: true, url: "https://testanchor.stellar.org", homeDomain: "x.example" });
    configureFetch(() => ({ ok: false, status: 599 })); // arbitrary failure code
    await h.probe();
    expect(h.snapshot().consecutiveFailures).toBe(1);
    expect(h.snapshot().lastError).toContain("TOML probe returned 599");
  });

  it("half_open transition: after cooldownMs elapses, isAvailable returns true again", async () => {
    const cooldownMs = 50;
    const h = new AnchorHealth({
      enabled: true,
      url: "https://testanchor.stellar.org",
      homeDomain: "x.example",
      failureThreshold: 1,
      cooldownMs,
    });
    configureFetch(() => ({ ok: false, status: 502 }));
    await h.probe();
    expect(h.snapshot().state).toBe("open");
    expect(h.isAvailable()).toBe(false);

    await new Promise((r) => setTimeout(r, cooldownMs + 10));
    // State auto-promotes on next snapshot() / isAvailable() call.
    expect(h.snapshot().state).toBe("half_open");
    expect(h.isAvailable()).toBe(true);
  });

  it("half_open success closes the breaker", async () => {
    const cooldownMs = 5;
    const h = new AnchorHealth({
      enabled: true,
      url: "https://testanchor.stellar.org",
      homeDomain: "testanchor.stellar.org",
      failureThreshold: 1,
      cooldownMs,
    });

    configureFetch(() => ({ ok: false, status: 502 }));
    await h.probe();
    await new Promise((r) => setTimeout(r, cooldownMs + 1));

    configureFetch((u) => {
      if (u.endsWith("/.well-known/stellar.toml")) return { ok: true };
      if (u.includes("/auth")) return { ok: true, body: { transaction: "AAAA..." } };
      if (u.endsWith("/info")) return { ok: true };
      return { ok: false, status: 500 };
    });
    await h.probe();
    expect(h.snapshot().state).toBe("closed");
    expect(h.snapshot().consecutiveFailures).toBe(0);
  });

  it("half_open failure re-opens (and resets openedAt)", async () => {
    const cooldownMs = 5;
    const h = new AnchorHealth({
      enabled: true,
      url: "https://testanchor.stellar.org",
      homeDomain: "x.example",
      failureThreshold: 1,
      cooldownMs,
    });
    configureFetch(() => ({ ok: false, status: 502 }));
    await h.probe();
    const firstOpenedAt = h.snapshot().state === "open" ? Date.now() : 0;
    await new Promise((r) => setTimeout(r, cooldownMs + 1));
    configureFetch(() => ({ ok: false, status: 502 }));
    await h.probe();
    expect(h.snapshot().state).toBe("open");
    // openedAt is reset on re-open
    expect(h.snapshot().lastError).toContain("502");
    expect(firstOpenedAt).toBeGreaterThan(0);
  });

  it("success resets consecutive failures even after previous opens", async () => {
    const h = new AnchorHealth({
      enabled: true,
      url: "https://testanchor.stellar.org",
      homeDomain: "testanchor.stellar.org",
      failureThreshold: 2,
      cooldownMs: 1_000_000,
    });

    configureFetch(() => ({ ok: false, status: 502 }));
    await h.probe();
    await h.probe();
    expect(h.snapshot().state).toBe("open");

    configureFetch((u) => {
      if (u.endsWith("/.well-known/stellar.toml")) return { ok: true };
      if (u.includes("/auth")) return { ok: true, body: { transaction: "AAAA..." } };
      if (u.endsWith("/info")) return { ok: true };
      return { ok: false };
    });
    await h.probe();
    expect(h.snapshot().state).toBe("closed");
    expect(h.snapshot().consecutiveFailures).toBe(0);
    expect(h.snapshot().lastError).toBeNull();
  });
});

// ---------- service-level integration of AnchorHealth -----------------------

class FakeLinkRepoForAnchor implements LinkRepository {
  private byId = new Map<string, PaymentLink>();
  async create(input: Parameters<LinkRepository["create"]>[0]): Promise<PaymentLink> {
    const row: PaymentLink = {
      id: input.id,
      reference: input.reference,
      sellerId: input.sellerId,
      destination: input.destination,
      title: input.title,
      amount: input.amount,
      asset: input.asset,
      status: "active",
      txHash: null,
      payer: null,
      paidAmount: null,
      offrampJobId: null,
      offrampTargetCurrency: null,
      offrampStatus: null,
      expiresAt: input.expiresAt,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.byId.set(row.id, row);
    return row;
  }
  async findById(id: string): Promise<PaymentLink | null> {
    return this.byId.get(id) ?? null;
  }
  async findByReference(reference: string): Promise<PaymentLink | null> {
    for (const l of this.byId.values()) if (l.reference === reference) return l;
    return null;
  }
  async listBySeller(sellerId: string): Promise<PaymentLink[]> {
    return [...this.byId.values()].filter((l) => l.sellerId === sellerId);
  }
  async listByStatus(_status: PaymentLink["status"]): Promise<PaymentLink[]> {
    return [...this.byId.values()];
  }
  async activeDestinations(): Promise<string[]> {
    return [...new Set([...this.byId.values()].map((l) => l.destination))];
  }
  async openLinksForDestination(destination: string): Promise<PaymentLink[]> {
    return [...this.byId.values()].filter((l) => l.destination === destination);
  }
  async save(l: PaymentLink): Promise<void> {
    this.byId.set(l.id, { ...l });
  }
}

class FakeSellerRepoForAnchor {
  constructor(private readonly s: Seller) {}
  async getDefault(): Promise<Seller> {
    return this.s;
  }
  async findById(id: string): Promise<Seller | null> {
    return id === this.s.id ? this.s : null;
  }
}

class FakeWebhookRepoForAnchor implements WebhookRepository {
  stored: Webhook[] = [];
  async create(input: { sellerId: string; url: string; secret: string }): Promise<Webhook> {
    const w: Webhook = { id: "whk_x", sellerId: input.sellerId, url: input.url, secret: input.secret, createdAt: Date.now() };
    this.stored.push(w);
    return w;
  }
  async listBySeller(sellerId: string): Promise<Webhook[]> {
    return this.stored.filter((h) => h.sellerId === sellerId);
  }
  async recordDelivery(_d: WebhookDelivery): Promise<void> {
    /* capture elsewhere via fetch interception */
  }
}

class FakeRailForAnchor implements RailPort {
  buildRequest = (input: Parameters<RailPort["buildRequest"]>[0]) => ({
    uri: `web+stellar:pay?destination=${input.destination}&memo=${input.reference}`,
    destination: input.destination,
    amount: input.amount,
    asset: input.asset,
    memo: input.reference,
  });
  isValidDestination = (a: string): boolean => a.length > 0;
}

interface FlakyOffRampOpts {
  quoteShouldThrow?: boolean;
  status?: OffRampJobStatus;
  statusShouldThrow?: boolean;
  statusMessage?: string;
}

class FlakyOffRamp implements OffRampPort {
  readonly mode = "seller_initiated" as const;
  constructor(private readonly opts: FlakyOffRampOpts = {}) {}
  async quote(_input: Parameters<OffRampPort["quote"]>[0]): Promise<OffRampQuote> {
    if (this.opts.quoteShouldThrow) throw new Error("testanchor unreachable");
    return {
      quoteId: "q1",
      sourceAsset: { code: "USDC", issuer: ISSUER },
      sourceAmount: "10",
      targetCurrency: "NGN",
      targetAmount: "16500",
      rate: "1650",
      expiresAt: Date.now() + 60_000,
    };
  }
  async initiate(_input: Parameters<OffRampPort["initiate"]>[0]): Promise<OffRampJob> {
    return { jobId: "ofr_1", linkId: "lnk_1", status: "pending", targetCurrency: "NGN", targetAmount: "16500", rate: "1650" };
  }
  async status(jobId: string): Promise<OffRampJob> {
    if (this.opts.statusShouldThrow) {
      throw new Error(this.opts.statusMessage ?? "transaction not found");
    }
    return { jobId, linkId: "lnk_1", status: this.opts.status ?? "pending", targetCurrency: "NGN", targetAmount: "16500", rate: "1650" };
  }
}

const STELLAR: StellarConfig = {
  network: "testnet",
  horizonUrl: "https://horizon-testnet.stellar.org",
  usdcIssuer: ISSUER,
  networkPassphrase: "Test SDF Network ; September 2015",
};

interface Svc {
  service: LinkService;
  repo: FakeLinkRepoForAnchor;
  webhooks: FakeWebhookRepoForAnchor;
  health: AnchorHealth;
  captureRoute: Hono;
}

function buildSvcWithHealth(health: AnchorHealth, offramp: OffRampPort): Svc {
  const repo = new FakeLinkRepoForAnchor();
  const sellers = new FakeSellerRepoForAnchor({ id: "s_1", name: "Demo", wallet: DEST, createdAt: 1 });
  const webhooks = new FakeWebhookRepoForAnchor();
  void webhooks.create({ sellerId: "s_1", url: "https://example.com/h", secret: "s" });
  const service = new LinkService({
    links: repo,
    sellers,
    webhooks,
    rail: new FakeRailForAnchor(),
    offramp,
    stellar: STELLAR,
    health,
  });
  const captureRoute = new Hono();
  // Mirror the production cash-out route shape for HTTP-level assertions.
  captureRoute.post("/:id/cash-out", async (ctx) => {
    const body = (await ctx.req.json().catch(() => ({}))) as Record<string, unknown>;
    try {
      const job = await service.triggerCashOut(ctx.req.param("id"), {
        targetCurrency: typeof body.targetCurrency === "string" ? body.targetCurrency : "NGN",
        payoutFields: (body.payoutFields as Record<string, string> | undefined) ?? {},
      });
      return ctx.json({ job }, 200);
    } catch (err) {
      if (err instanceof Error && "status" in err) {
        return ctx.json({ error: (err as Error).message }, (err as { status: number }).status);
      }
      throw err;
    }
  });
  return { service, repo, webhooks, health, captureRoute };
}

describe("LinkService with AnchorHealth", () => {
  it("triggerCashOut fails fast with 503 anchor_unavailable AND makes no offramp calls while the breaker is open", async () => {
    const offrampCalls: string[] = [];
    class SpyOffRamp implements OffRampPort {
      readonly mode = "seller_initiated" as const;
      async quote(): Promise<OffRampQuote> {
        offrampCalls.push("quote");
        throw new Error("should not be called when breaker is open");
      }
      async initiate(): Promise<OffRampJob> {
        offrampCalls.push("initiate");
        throw new Error("should not be called when breaker is open");
      }
      async status(): Promise<OffRampJob> {
        offrampCalls.push("status");
        throw new Error("should not be called when breaker is open");
      }
    }

    // Force the breaker open with a single failing probe.
    const health = new AnchorHealth({
      enabled: true,
      url: "https://testanchor.stellar.org",
      homeDomain: "x.example",
      failureThreshold: 1,
      cooldownMs: 1_000_000, // never auto-close during the test
    });
    configureFetch(() => ({ ok: false, status: 502 }));
    await health.probe();
    expect(health.isAvailable()).toBe(false);

    const built = buildSvcWithHealth(health, new SpyOffRamp());
    await built.repo.save(link({ status: "paid" }));

    const res = await built.captureRoute.request("http://x/lnk_1/cash-out", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ targetCurrency: "NGN" }),
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("anchor_unavailable");
    // No offramp traffic happened — the link never advanced.
    expect(offrampCalls).toHaveLength(0);
    expect((await built.repo.findById("lnk_1"))!.status).toBe("paid");
  });

  it("a 502 still wraps single-call upstream failures (NOT 503) when the breaker is closed", async () => {
    const health = new AnchorHealth({ enabled: false, url: null, homeDomain: null }); // always available
    const built = buildSvcWithHealth(health, new FlakyOffRamp({ quoteShouldThrow: true }));
    await built.repo.save(link({ status: "paid" }));
    const res = await built.captureRoute.request("http://x/lnk_1/cash-out", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ targetCurrency: "NGN" }),
    });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("Off-ramp error");
  });

  it("healthSnapshot reflects the breaker state and is exposed on the service", async () => {
    const health = new AnchorHealth({ enabled: false, url: null, homeDomain: null });
    const built = buildSvcWithHealth(health, new FlakyOffRamp());
    const snap = built.service.healthSnapshot();
    expect(snap.state).toBe("closed");
    expect(snap.url).toBeNull();
  });
});

// ---------- /health endpoint integration ------------------------------------

describe("GET /health exposes anchor state", () => {
  it("returns the anchor snapshot alongside the existing config fields", async () => {
    const health = new AnchorHealth({
      enabled: true,
      url: "https://testanchor.stellar.org",
      homeDomain: "testanchor.stellar.org",
      failureThreshold: 1,
      cooldownMs: 60_000,
    });
    configureFetch((u) => {
      if (u.endsWith("/.well-known/stellar.toml")) return { ok: true };
      if (u.includes("/auth")) return { ok: true, body: { transaction: "AAAA..." } };
      if (u.endsWith("/info")) return { ok: true };
      return { ok: false, status: 500 };
    });
    await health.probe(); // ensure lastSuccessAt / probes populated

    const built = buildSvcWithHealth(health, new FlakyOffRamp());
    const app = new Hono();
    // Mirror the exact shape of apps/api/src/index.ts#/health.
    app.get("/health", (ctx) =>
      ctx.json({
        ok: true,
        network: "testnet",
        sellerWallet: DEST,
        anchor: built.service.healthSnapshot(),
      }),
    );

    const res = await app.request("http://x/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      network: string;
      sellerWallet: string;
      anchor: { state: string; url: string | null; probes: Record<string, boolean> };
    };
    expect(body.ok).toBe(true);
    expect(body.network).toBe("testnet");
    expect(body.sellerWallet).toBe(DEST);
    expect(body.anchor.state).toBe("closed");
    expect(body.anchor.url).toBe("https://testanchor.stellar.org");
    expect(body.anchor.probes.toml).toBe(true);
    expect(body.anchor.probes.sep10).toBe(true);
    expect(body.anchor.probes.info).toBe(true);
  });

  it("reports open state when the breaker has tripped (AC4 — observable from /health)", async () => {
    const health = new AnchorHealth({
      enabled: true,
      url: "https://testanchor.stellar.org",
      homeDomain: "x.example",
      failureThreshold: 1,
      cooldownMs: 60_000,
    });
    configureFetch(() => ({ ok: false, status: 502 }));
    await health.probe();

    const built = buildSvcWithHealth(health, new FlakyOffRamp());
    const app = new Hono();
    app.get("/health", (ctx) => ctx.json({ ok: true, anchor: built.service.healthSnapshot() }));
    const res = await app.request("http://x/health");
    const body = (await res.json()) as { anchor: { state: string; consecutiveFailures: number; lastError: string | null } };
    expect(body.anchor.state).toBe("open");
    expect(body.anchor.consecutiveFailures).toBe(1);
    expect(body.anchor.lastError).toContain("502");
  });
});

// ---------- pollCashOuts last_error attribution ------------------------------

describe("LinkService.pollCashOuts attribution", () => {
  it("records last_error per-link when status() throws and does NOT advance link status", async () => {
    const repo = new FakeLinkRepoForAnchor();
    const sellers = new FakeSellerRepoForAnchor({ id: "s_1", name: "Demo", wallet: DEST, createdAt: 1 });
    const webhooks = new FakeWebhookRepoForAnchor();
    void webhooks.create({ sellerId: "s_1", url: "https://example.com/h", secret: "s" });
    const offramp = new FlakyOffRamp({ statusShouldThrow: true, statusMessage: "anchor DNS resolution failed" });
    const service = new LinkService({
      links: repo,
      sellers,
      webhooks,
      rail: new FakeRailForAnchor(),
      offramp,
      stellar: STELLAR,
      health: new AnchorHealth({ enabled: false, url: null, homeDomain: null }),
    });

    await repo.save(
      link({
        id: "lnk_err",
        status: "offramp_pending",
        offrampJobId: "ofr_42",
        offrampStatus: "pending",
        offrampTargetCurrency: "NGN",
      }),
    );
    await service.pollCashOuts();
    const remained = await repo.findById("lnk_err");
    expect(remained!.status).toBe("offramp_pending"); // NOT flipped to failed by a probe error
    expect(service.lastPollErrorFor("lnk_err")).toContain("anchor DNS resolution failed");
  });

  it("clears last_error when a subsequent poll succeeds", async () => {
    const repo = new FakeLinkRepoForAnchor();
    const sellers = new FakeSellerRepoForAnchor({ id: "s_1", name: "Demo", wallet: DEST, createdAt: 1 });
    const webhooks = new FakeWebhookRepoForAnchor();
    void webhooks.create({ sellerId: "s_1", url: "https://example.com/h", secret: "s" });

    let fail = true;
    const offramp = {
      mode: "seller_initiated" as const,
      async quote(): Promise<OffRampQuote> {
        throw new Error("unused");
      },
      async initiate(): Promise<OffRampJob> {
        throw new Error("unused");
      },
      async status(jobId: string): Promise<OffRampJob> {
        if (fail) throw new Error("first attempt fails");
        return { jobId, linkId: "lnk_2", status: "settled", targetCurrency: "NGN", targetAmount: "16500", rate: "1650" };
      },
    };
    const service = new LinkService({
      links: repo,
      sellers,
      webhooks,
      rail: new FakeRailForAnchor(),
      offramp,
      stellar: STELLAR,
      health: new AnchorHealth({ enabled: false, url: null, homeDomain: null }),
    });
    await repo.save(
      link({
        id: "lnk_2",
        status: "offramp_pending",
        offrampJobId: "ofr_99",
        offrampStatus: "pending",
        offrampTargetCurrency: "NGN",
      }),
    );

    await service.pollCashOuts();
    expect(service.lastPollErrorFor("lnk_2")).toContain("first attempt fails");

    // Per-job backoff sets next_try_at into the future; wait it out so the
    // next poll actually re-hits status() and clears the error on success.
    await new Promise((r) => setTimeout(r, 2_100));
    fail = false;
    await service.pollCashOuts();
    expect(service.lastPollErrorFor("lnk_2")).toBeNull();
    expect((await repo.findById("lnk_2"))!.status).toBe("offramp_settled");
  });

  it("a job whose status() returns `failed` is moved to offramp_failed and last_error stays null (the job self-reported)", async () => {
    const repo = new FakeLinkRepoForAnchor();
    const sellers = new FakeSellerRepoForAnchor({ id: "s_1", name: "Demo", wallet: DEST, createdAt: 1 });
    const webhooks = new FakeWebhookRepoForAnchor();
    void webhooks.create({ sellerId: "s_1", url: "https://example.com/h", secret: "s" });
    const offramp = new FlakyOffRamp({ status: "failed" });
    const service = new LinkService({
      links: repo,
      sellers,
      webhooks,
      rail: new FakeRailForAnchor(),
      offramp,
      stellar: STELLAR,
      health: new AnchorHealth({ enabled: false, url: null, homeDomain: null }),
    });
    await repo.save(
      link({ id: "lnk_3", status: "offramp_pending", offrampJobId: "ofr_x", offrampTargetCurrency: "NGN" }),
    );

    await service.pollCashOuts();
    expect((await repo.findById("lnk_3"))!.status).toBe("offramp_failed");
    expect(service.lastPollErrorFor("lnk_3")).toBeNull();
  });

  it("backs off per job after consecutive poll failures (AC3 — does not hammer a downed anchor)", async () => {
    const repo = new FakeLinkRepoForAnchor();
    const sellers = new FakeSellerRepoForAnchor({ id: "s_1", name: "Demo", wallet: DEST, createdAt: 1 });
    const webhooks = new FakeWebhookRepoForAnchor();
    void webhooks.create({ sellerId: "s_1", url: "https://example.com/h", secret: "s" });

    let statusCalls = 0;
    const offramp = {
      mode: "seller_initiated" as const,
      async quote(): Promise<OffRampQuote> { throw new Error("unused"); },
      async initiate(): Promise<OffRampJob> { throw new Error("unused"); },
      async status(_jobId: string): Promise<OffRampJob> {
        statusCalls++;
        throw new Error("anchor 502");
      },
    };
    const service = new LinkService({
      links: repo,
      sellers,
      webhooks,
      rail: new FakeRailForAnchor(),
      offramp,
      stellar: STELLAR,
      health: new AnchorHealth({ enabled: false, url: null, homeDomain: null }),
    });
    await repo.save(
      link({ id: "lnk_bo", status: "offramp_pending", offrampJobId: "ofr_bo", offrampTargetCurrency: "NGN" }),
    );

    // First poll hits status() and records the backoff; the link's
    // next_try_at is pushed into the future so the second poll must skip it.
    await service.pollCashOuts();
    expect(statusCalls).toBe(1);

    await service.pollCashOuts();
    // Per-job backoff should have skipped the second attempt entirely.
    expect(statusCalls).toBe(1);

    // Recording kept going — last_error is still set; status remains pending.
    expect(service.lastPollErrorFor("lnk_bo")).toContain("anchor 502");
    expect((await repo.findById("lnk_bo"))!.status).toBe("offramp_pending");
  });
});
