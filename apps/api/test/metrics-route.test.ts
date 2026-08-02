import { describe, expect, it } from "vitest";
import type { Container } from "../src/services/container";
import { metricsRoutes } from "../src/routes/metrics";

function fakeContainer(): Container {
  return {
    service: { webhookQueueDepth: () => 2 } as unknown as Container["service"],
    links: {
      activeDestinations: async () => ["GA...1", "GA...2"],
      listByStatus: async () => [{}, {}, {}],
    } as unknown as Container["links"],
    sellers: {} as Container["sellers"],
    webhooks: {} as Container["webhooks"],
    config: { network: "testnet", horizonUrl: "https://horizon-testnet.stellar.org", sellerWallet: "GSELLER" },
    metricsToken: "secret-token",
    watcherLagSeconds: () => 1.5,
    circuitBreakerState: () => 0,
    horizonStatus: () => ({ degraded: false, usingFallback: false, consecutiveFailures: 0 }),
    kyc: {} as Container["kyc"],
    db: {} as Container["db"],
    auth: {} as Container["auth"],
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

describe("metricsRoutes", () => {
  it("rejects requests with no or wrong token", async () => {
    const app = metricsRoutes(fakeContainer());

    const noAuth = await app.request("/");
    expect(noAuth.status).toBe(401);

    const wrong = await app.request("/", { headers: { authorization: "Bearer nope" } });
    expect(wrong.status).toBe(401);
  });

  it("accepts a bearer token and returns Prometheus text with live gauges", async () => {
    const app = metricsRoutes(fakeContainer());
    const res = await app.request("/", { headers: { authorization: "Bearer secret-token" } });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    const body = await res.text();
    expect(body).toContain("accounts_watched 2");
    expect(body).toContain("pending_cash_outs 3");
    expect(body).toContain("webhook_deliveries_in_flight 2");
    expect(body).toContain("watcher_lag_seconds 1.5");
  });

  it("also accepts the token via ?token=", async () => {
    const app = metricsRoutes(fakeContainer());
    const res = await app.request("/?token=secret-token");
    expect(res.status).toBe(200);
  });
});
