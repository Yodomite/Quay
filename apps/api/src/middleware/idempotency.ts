import type { Context, Next } from "hono";
import { createHash } from "node:crypto";
import { eq, and, lt } from "drizzle-orm";
import type { DB } from "../db/client";
import { idempotencyKeys } from "../db/schema";

const TTL_MS = 24 * 60 * 60 * 1000;

// In-flight keys: key -> sellerId
const inFlight = new Map<string, string>();

function hashBody(body: unknown): string {
  return createHash("sha256").update(JSON.stringify(body)).digest("hex");
}

/**
 * Scopes stored responses to the *authenticated* seller, so this must be
 * mounted AFTER `requireSeller` — it reads the seller off the context rather
 * than taking a fixed id, which is what it did before routes were auth-gated.
 */
export function idempotency(db: DB) {
  return async (ctx: Context, next: Next) => {
    const key = ctx.req.header("idempotency-key");
    if (!key) return next();

    const seller = ctx.get("seller") as { id: string } | undefined;
    if (!seller) return next(); // unauthenticated route — nothing to scope to
    const sellerId = seller.id;

    const endpoint = `${ctx.req.method} ${ctx.req.path}`;
    const rawBody = await ctx.req.text();
    let parsed: unknown;
    try { parsed = JSON.parse(rawBody); } catch { parsed = rawBody; }
    const reqHash = hashBody(parsed);

    // Sweep expired rows opportunistically
    await db.delete(idempotencyKeys).where(lt(idempotencyKeys.createdAt, Date.now() - TTL_MS));

    // Check stored result
    const rows = await db
      .select()
      .from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.key, key), eq(idempotencyKeys.sellerId, sellerId)))
      .limit(1);

    if (rows[0]) {
      if (rows[0].requestHash !== reqHash) {
        return ctx.json({ error: "idempotency_key_reuse" }, 409);
      }
      // Replay stored response byte-identical
      return ctx.newResponse(rows[0].responseBody, rows[0].responseStatus as 200 | 201, {
        "content-type": "application/json",
        "idempotent-replayed": "true",
      });
    }

    // In-flight guard
    const flightKey = `${sellerId}:${key}`;
    if (inFlight.has(flightKey)) {
      return ctx.json({ error: "request_in_progress" }, 409);
    }
    inFlight.set(flightKey, sellerId);

    // Patch ctx.json to capture the response before sending
    let capturedBody: string | null = null;
    let capturedStatus = 200;
    const origJson = ctx.json.bind(ctx);
    // Wraps ctx.json so the handler's response can be persisted for replay.
    // Cast because Hono's JSONRespond is a heavily-overloaded signature that a
    // plain (data, status) function can't structurally satisfy.
    ctx.json = ((data: unknown, status?: number) => {
      capturedBody = JSON.stringify(data);
      capturedStatus = status ?? 200;
      return origJson(data, status as never);
    }) as typeof ctx.json;

    try {
      await next();
    } finally {
      inFlight.delete(flightKey);
    }

    if (capturedBody !== null && capturedStatus < 500) {
      await db
        .insert(idempotencyKeys)
        .values({
          key,
          sellerId,
          endpoint,
          requestHash: reqHash,
          responseStatus: capturedStatus,
          responseBody: capturedBody,
          createdAt: Date.now(),
        })
        .onConflictDoNothing();
    }
  };
}
