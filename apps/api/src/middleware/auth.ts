import { getCookie } from "hono/cookie";
import type { Context, MiddlewareHandler, Next } from "hono";
import type { Seller, SellerRepository, TokenRevocationRepository } from "@checkout/core";
import type { SessionIssuer } from "../services/session";

export const SESSION_COOKIE = "session";

export interface AuthedVariables {
  seller: Seller;
  jti: string;
  /** epoch seconds — the verified token's own `exp`, handed to routes (e.g.
   *  logout) that need it without re-decoding the raw token themselves. */
  sessionExp: number;
}

/**
 * Resolves `Authorization: Bearer <token>` (or the httpOnly `session` cookie,
 * for SSR requests that can't hold the token in JS memory) into an
 * authenticated `Seller`, bound onto the request context as `ctx.get("seller")`.
 *
 * 401 vs 403: this middleware only ever produces 401 (`unauthorized`) — no
 * token, or one that's malformed, expired, tampered, or revoked. 403
 * (`forbidden`) is a route-level concern for an authenticated seller acting on
 * a resource that isn't theirs (see `links.ts`'s ownership check) — a
 * different failure mode from "who even are you."
 */
export function requireSeller(deps: {
  session: SessionIssuer;
  sellers: SellerRepository;
  revocations: TokenRevocationRepository;
}): MiddlewareHandler<{ Variables: AuthedVariables }> {
  return async (ctx: Context<{ Variables: AuthedVariables }>, next: Next) => {
    const header = ctx.req.header("authorization");
    const bearer = header?.match(/^Bearer\s+(.+)$/i)?.[1];
    const token = bearer ?? getCookie(ctx, SESSION_COOKIE);

    if (!token) {
      return ctx.json({ error: "unauthorized", message: "missing session token" }, 401);
    }

    let payload;
    try {
      payload = await deps.session.verify(token);
    } catch {
      return ctx.json({ error: "unauthorized", message: "invalid, tampered, or expired session token" }, 401);
    }

    if (await deps.revocations.isRevoked(payload.jti)) {
      return ctx.json({ error: "unauthorized", message: "session has been revoked" }, 401);
    }

    const seller = await deps.sellers.findById(payload.sellerId);
    if (!seller) {
      return ctx.json({ error: "unauthorized", message: "seller no longer exists" }, 401);
    }

    ctx.set("seller", seller);
    ctx.set("jti", payload.jti);
    ctx.set("sessionExp", payload.exp);
    await next();
  };
}
