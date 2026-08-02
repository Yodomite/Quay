import { Hono, type MiddlewareHandler } from "hono";
import { createLinkSchema, cashOutSchema } from "@checkout/core";
import type { Container } from "../services/container";
import { HttpError } from "../services/link-service";
import { requireSeller, type AuthedVariables } from "../middleware/auth";
import { idempotency } from "../middleware/idempotency";

export function linkRoutes(c: Container, strictRateLimit: MiddlewareHandler): Hono<{ Variables: AuthedVariables }> {
  const app = new Hono<{ Variables: AuthedVariables }>();
  // Applied per-route, NOT via app.use("*", ...). `GET /links/:id` is the
  // buyer-facing checkout fetch: the buyer paying an invoice is not the seller
  // and holds no session, and `apps/web/app/pay/[id]/page.tsx` renders it in a
  // server component with no cookie at all. Gating it would 401 every checkout.
  const auth = requireSeller({ session: c.auth.session, sellers: c.sellers, revocations: c.auth.revocations });

  // Idempotency is mounted after `auth` so it can scope stored responses to the
  // authenticated seller (issue #26).
  const idempotent = idempotency(c.db);

  // strictRateLimit runs BEFORE auth so unauthenticated floods are throttled
  // too — a limiter that only applies to valid sessions protects nothing.
  // Create a payment link.
  app.post("/", strictRateLimit, auth, idempotent, async (ctx) => {
    const parsed = createLinkSchema.safeParse(await safeJson(ctx));
    if (!parsed.success) return ctx.json({ error: "invalid_body", issues: parsed.error.issues }, 400);
    try {
      const result = await c.service.createLink(ctx.get("seller").id, parsed.data);
      return ctx.json(result, 201);
    } catch (err) {
      if (err instanceof HttpError) return ctx.json({ error: err.message, ...err.extra }, err.status as 422);
      throw err;
    }
  });

  // List the seller's links.
  app.get("/", auth, async (ctx) => {
    return ctx.json({ links: await c.service.listLinks(ctx.get("seller").id) });
  });

  // Fetch one link plus its payment request (for the checkout page).
  // PUBLIC by design — the link id is the bearer capability, and the buyer must
  // be able to read this to pay. Returns only what the checkout page renders.
  app.get("/:id", async (ctx) => {
    const result = await c.service.getLink(ctx.req.param("id"));
    if (!result) return ctx.json({ error: "not_found" }, 404);
    return ctx.json(result);
  });

  // Seller-initiated cash-out to local currency.
  app.post("/:id/cash-out", strictRateLimit, auth, idempotent, async (ctx) => {
    const parsed = cashOutSchema.safeParse(await safeJson(ctx));
    if (!parsed.success) return ctx.json({ error: "invalid_body", issues: parsed.error.issues }, 400);
    try {
      const existing = await c.service.getLink(ctx.req.param("id"));
      if (!existing) return ctx.json({ error: "not_found" }, 404);
      if (existing.link.sellerId !== ctx.get("seller").id) {
        return ctx.json({ error: "forbidden", message: "this link belongs to a different seller" }, 403);
      }
      const job = await c.service.triggerCashOut(ctx.req.param("id"), parsed.data);
      return ctx.json({ job });
    } catch (err) {
      if (err instanceof HttpError) return ctx.json({ error: err.message }, err.status as 403 | 404 | 409 | 502);
      throw err;
    }
  });

  // Seller voids a link they created by mistake. Idempotent: cancelling an
  // already-`cancelled` link is a successful no-op. Any state from which
  // `cancelled` is not reachable is rejected with 409 (the on-chain payment
  // must NOT be reversed client-side; the seller refunds out of band via the
  // off-ramp / from their own wallet). No request body.
  app.post("/:id/cancel", auth, async (ctx) => {
    try {
      // Ownership check mirrors cash-out: a link id alone must not let one
      // seller void another seller's link.
      const existing = await c.service.getLink(ctx.req.param("id"));
      if (!existing) return ctx.json({ error: "not_found" }, 404);
      if (existing.link.sellerId !== ctx.get("seller").id) {
        return ctx.json({ error: "forbidden", message: "this link belongs to a different seller" }, 403);
      }
      const link = await c.service.cancelLink(ctx.req.param("id"));
      return ctx.json({ link });
    } catch (err) {
      if (err instanceof HttpError) return ctx.json({ error: err.message }, err.status as 403 | 404 | 409);
      throw err;
    }
  });

  return app;
}

async function safeJson(ctx: { req: { json: () => Promise<unknown> } }): Promise<unknown> {
  try {
    return await ctx.req.json();
  } catch {
    return {};
  }
}
