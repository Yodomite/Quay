import { Hono } from "hono";
import type { Container } from "../services/container";
import { metrics } from "../metrics";

/** `GET /metrics` in Prometheus text format, guarded by a bearer token
 *  (`Authorization: Bearer <token>` or `?token=`). */
export function metricsRoutes(container: Container): Hono {
  const app = new Hono();

  app.get("/", async (ctx) => {
    const header = ctx.req.header("authorization");
    const bearer = header?.match(/^Bearer\s+(.+)$/i)?.[1];
    const provided = bearer ?? ctx.req.query("token");
    if (provided !== container.metricsToken) return ctx.text("unauthorized\n", 401);

    const [accounts, pendingCashOuts] = await Promise.all([
      container.links.activeDestinations(),
      container.links.listByStatus("offramp_pending"),
    ]);
    metrics.accountsWatched.set(accounts.length);
    metrics.pendingCashOuts.set(pendingCashOuts.length);
    metrics.webhookQueueDepth.set(container.service.webhookQueueDepth());
    metrics.circuitBreakerState.set(container.circuitBreakerState());
    metrics.watcherLagSeconds.set(container.watcherLagSeconds());

    return ctx.text(metrics.registry.render(), 200, {
      "content-type": "text/plain; version=0.0.4; charset=utf-8",
    });
  });

  return app;
}
