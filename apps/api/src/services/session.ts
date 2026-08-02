import { randomBytes } from "node:crypto";
import { sign, verify } from "hono/jwt";

export interface SessionPayload {
  sub: string; // Stellar G-address — the identity SEP-10 proved control of
  sellerId: string;
  jti: string; // unique per issued token — what the revocation list keys on
  exp: number; // epoch seconds — sizes the revocation row's own sweep-safe expiry
}

export interface IssuedSession {
  token: string;
  jti: string;
  expiresAt: number; // epoch seconds
}

const MAX_TTL_SECONDS = 24 * 60 * 60; // hard cap regardless of configured ttl — "exp <= 24h"

/**
 * Issues and verifies the session JWT minted after a successful SEP-10 login.
 * There is no refresh token by design — a session is renewed by re-signing a
 * fresh SEP-10 challenge (`POST /auth`), the same way it was issued the first
 * time. `jti` is what `requireSeller` checks against the revocation list for
 * logout / compromise.
 */
export class SessionIssuer {
  private readonly ttlSeconds: number;

  constructor(
    private readonly secret: string,
    ttlSeconds = MAX_TTL_SECONDS,
  ) {
    this.ttlSeconds = Math.min(ttlSeconds, MAX_TTL_SECONDS);
  }

  async issue(payload: { sub: string; sellerId: string }): Promise<IssuedSession> {
    const now = Math.floor(Date.now() / 1000);
    const jti = randomBytes(16).toString("hex");
    const exp = now + this.ttlSeconds;
    const token = await sign({ sub: payload.sub, sellerId: payload.sellerId, jti, iat: now, exp }, this.secret, "HS256");
    return { token, jti, expiresAt: exp };
  }

  /** Verifies signature and expiry (tampered/expired tokens throw). Does NOT
   *  check revocation — that's `requireSeller`'s job, since it needs the
   *  repository and this class stays storage-agnostic. */
  async verify(token: string): Promise<SessionPayload> {
    const decoded = await verify(token, this.secret, "HS256");
    if (
      typeof decoded.sub !== "string" ||
      typeof decoded.sellerId !== "string" ||
      typeof decoded.jti !== "string" ||
      typeof decoded.exp !== "number"
    ) {
      throw new Error("malformed session token");
    }
    return { sub: decoded.sub, sellerId: decoded.sellerId, jti: decoded.jti, exp: decoded.exp };
  }
}
