import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { env } from "./env";
import { createContainer } from "./services/container";
import { linkRoutes } from "./routes/links";
import { webhookRoutes } from "./routes/webhooks";
import { metricsRoutes } from "./routes/metrics";
import { authRoutes } from "./routes/auth";
import { wellKnownRoutes } from "./routes/well-known";
import { kycRoutes } from "./routes/kyc";
import { rateLimit, MemoryStore } from "./middleware/rate-limit";
import { RedisStore } from "./middleware/redis-store";

const SHUTDOWN_TIMEOUT_MS = env.shutdownTimeoutMs;

async function main(): Promise<void> {
  const container = await createContainer();

  const app = new Hono();
  const rateLimitStore = env.redisUrl ? new RedisStore(env.redisUrl) : new MemoryStore();
  app.use(
    "*",
    cors({
      origin: env.corsOrigins,
      allowMethods: ["GET", "POST", "PUT", "OPTIONS"],
      // The session cookie is sent cross-origin (API and web app are separate
      // hosts) — credentials: true plus an explicit (non-"*") origin list is
      // required for the browser to actually attach/accept it.
      credentials: true,
    }),
  );
  app.use(
    "*",
    rateLimit({
      windowMs: env.rateLimitWindowMs,
      max: env.rateLimitMax,
      store: rateLimitStore,
      trustProxyHops: env.trustProxyHops,
    }),
  );
  const strictRateLimit = rateLimit({
    windowMs: env.rateLimitStrictWindowMs,
    max: env.rateLimitStrictMax,
    store: rateLimitStore,
    trustProxyHops: env.trustProxyHops,
  });

  app.get("/health", async (ctx) => {
    const usdcTrustline = await container.service
      .checkSellerUsdcTrustline()
      .catch(() => ({ ok: false as const, reason: "check_failed", message: "trustline preflight check failed" }));
    return ctx.json({
      ok: true,
      network: container.config.network,
      sellerWallet: container.config.sellerWallet,
      usdcTrustline,
      horizon: container.horizonStatus(),
      // Anchor health probe + circuit breaker (issue #19, 3.7) so an operator
      // can tell "the anchor is down" apart from "the API is down" without
      // tailing logs.
      anchor: container.service.healthSnapshot(),
    });
  });

  app.get("/ready", (ctx) => {
    const circuitBreakers = container.getWatcherCircuitBreakerStatus();
    const metrics = container.getWatcherMetrics();
    
    const hasOpenCircuitBreakers = circuitBreakers.some((cb) => cb.isOpen);
    
    return ctx.json({
      ok: !hasOpenCircuitBreakers,
      circuitBreakers,
      metrics: {
        accountsWatched: metrics.accountsWatched,
        tickDurationMs: metrics.tickDurationMs,
        circuitBreakersOpen: metrics.circuitBreakersOpen,
        perAccountLag: Object.fromEntries(metrics.perAccountLag),
      },
    });
  });

  app.route("/links", linkRoutes(container, strictRateLimit));
  app.route("/webhooks", webhookRoutes(container));
  app.route("/metrics", metricsRoutes(container));
  app.route(
    "/auth",
    authRoutes({
      challenge: container.auth.challenge,
      session: container.auth.session,
      sellers: container.sellers,
      revocations: container.auth.revocations,
      secureCookie: container.auth.secureCookie,
    }),
  );
  app.route("/.well-known", wellKnownRoutes(container.auth.stellarToml));
  app.route("/seller/kyc", kycRoutes(container));

  container.start();

  let server: ReturnType<typeof serve> | undefined = serve({ fetch: app.fetch, port: env.apiPort }, (info) => {
    console.log(`[api] listening on http://localhost:${info.port}`);
    console.log(`[api] network=${container.config.network}  horizon=${container.config.horizonUrl}`);
    console.log(`[api] seller wallet (receives funds): ${container.config.sellerWallet}`);
    console.log(`[watcher] polling every ${env.pollMs}ms`);
  });

  const shutdown = () => {
    console.log("\n[api] shutting down…");
    container.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[api] fatal:", err);
  process.exit(1);
});
