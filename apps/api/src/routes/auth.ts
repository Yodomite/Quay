import { Hono } from "hono";
import { setCookie, deleteCookie } from "hono/cookie";
import { z } from "zod";
import { AuthError, type ChallengeService } from "../services/challenge";
import type { SessionIssuer } from "../services/session";
import type { SellerRepository, TokenRevocationRepository } from "@checkout/core";
import { requireSeller, SESSION_COOKIE, type AuthedVariables } from "../middleware/auth";

const postAuthSchema = z.object({ transaction: z.string().min(1) });

export function authRoutes(deps: {
  challenge: ChallengeService;
  session: SessionIssuer;
  sellers: SellerRepository;
  revocations: TokenRevocationRepository;
  /** Set to false in non-HTTPS local dev so the cookie is actually sent (default true). */
  secureCookie?: boolean;
}): Hono<{ Variables: AuthedVariables }> {
  const app = new Hono<{ Variables: AuthedVariables }>();
  const secure = deps.secureCookie ?? true;

  // Step 1 of SEP-10: issue a challenge transaction for the client to sign.
  app.get("/", (ctx) => {
    const account = ctx.req.query("account");
    if (!account) return ctx.json({ error: "missing_account" }, 400);
    try {
      return ctx.json(deps.challenge.build(account));
    } catch (err) {
      if (err instanceof AuthError) return ctx.json({ error: err.message }, 400);
      throw err;
    }
  });

  // Step 2: verify the client-signed challenge and mint a session. Sets the
  // token as an httpOnly cookie (for SSR) AND returns it in the body (for the
  // browser to keep in memory and send as `Authorization: Bearer`) — never
  // localStorage on the web side.
  app.post("/", async (ctx) => {
    const parsed = postAuthSchema.safeParse(await safeJson(ctx));
    if (!parsed.success) return ctx.json({ error: "invalid_body", issues: parsed.error.issues }, 400);

    let account: string;
    try {
      account = await deps.challenge.verify(parsed.data.transaction);
    } catch (err) {
      if (err instanceof AuthError) return ctx.json({ error: err.message }, 401);
      throw err;
    }

    const seller = await deps.sellers.createIfAbsent(account);
    const { token, expiresAt } = await deps.session.issue({ sub: account, sellerId: seller.id });

    setCookie(ctx, SESSION_COOKIE, token, {
      httpOnly: true,
      secure,
      sameSite: "Lax",
      path: "/",
      maxAge: Math.max(0, expiresAt - Math.floor(Date.now() / 1000)),
    });
    return ctx.json({ token, expiresAt });
  });

  // Logout: revoke the current token's jti (works even if the caller only has
  // the httpOnly cookie, since requireSeller accepts either) and clear the cookie.
  app.post("/logout", requireSeller(deps), async (ctx) => {
    await deps.revocations.revoke(ctx.get("jti"), ctx.get("sessionExp"));
    deleteCookie(ctx, SESSION_COOKIE, { path: "/" });
    return ctx.json({ ok: true });
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
