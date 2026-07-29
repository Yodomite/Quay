import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { env } from "./env";
import { createContainer } from "./services/container";
import { linkRoutes } from "./routes/links";
import { webhookRoutes } from "./routes/webhooks";
import { rateLimit } from "./middleware/rate-limit";

const SHUTDOWN_TIMEOUT_MS = env.shutdownTimeoutMs;

async function main(): Promise<void> {
  const container = await createContainer();

  const app = new Hono();
  app.use("*", cors({ origin: env.corsOrigins, allowMethods: ["GET", "POST", "OPTIONS"] }));
  app.use("*", rateLimit({ windowMs: env.rateLimitWindowMs, max: env.rateLimitMax }));

  app.get("/health", (ctx) =>
    ctx.json({
      ok: true,
      network: container.config.network,
      sellerWallet: container.config.sellerWallet,
      // Anchor health probe + circuit breaker (issue #19, 3.7) so an operator
      // can tell "the anchor is down" apart from "the API is down" without
      // tailing logs.
      anchor: container.service.healthSnapshot(),
    }),
  );

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

  app.route("/links", linkRoutes(container));
  app.route("/webhooks", webhookRoutes(container));

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
