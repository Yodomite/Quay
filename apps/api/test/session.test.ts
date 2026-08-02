import { describe, expect, it } from "vitest";
import { SessionIssuer } from "../src/services/session";

describe("SessionIssuer", () => {
  it("issues a token that verifies back to the same identity, with a jti", async () => {
    const issuer = new SessionIssuer("test-secret");
    const issued = await issuer.issue({ sub: "GABC123", sellerId: "sel_1" });
    expect(issued.jti).toMatch(/^[0-9a-f]{32}$/);

    const payload = await issuer.verify(issued.token);
    expect(payload.sub).toBe("GABC123");
    expect(payload.sellerId).toBe("sel_1");
    expect(payload.jti).toBe(issued.jti);
    expect(payload.exp).toBe(issued.expiresAt);
  });

  it("issues a different jti for every session, even for the same seller", async () => {
    const issuer = new SessionIssuer("test-secret");
    const a = await issuer.issue({ sub: "GABC123", sellerId: "sel_1" });
    const b = await issuer.issue({ sub: "GABC123", sellerId: "sel_1" });
    expect(a.jti).not.toBe(b.jti);
  });

  it("caps the ttl at 24h even if a longer one is configured", async () => {
    const issuer = new SessionIssuer("test-secret", 999 * 24 * 60 * 60);
    const now = Math.floor(Date.now() / 1000);
    const issued = await issuer.issue({ sub: "GABC123", sellerId: "sel_1" });
    expect(issued.expiresAt - now).toBeLessThanOrEqual(24 * 60 * 60);
  });

  it("rejects a token signed with a different secret (tampered)", async () => {
    const issued = await new SessionIssuer("secret-a").issue({ sub: "GABC123", sellerId: "sel_1" });
    await expect(new SessionIssuer("secret-b").verify(issued.token)).rejects.toThrow();
  });

  it("rejects a token whose payload was altered without re-signing", async () => {
    const issuer = new SessionIssuer("test-secret");
    const issued = await issuer.issue({ sub: "GABC123", sellerId: "sel_1" });
    const [header, , signature] = issued.token.split(".");
    const forgedPayload = Buffer.from(JSON.stringify({ sub: "GEVIL", sellerId: "sel_1", jti: "x", exp: 9999999999 })).toString(
      "base64url",
    );
    const forged = `${header}.${forgedPayload}.${signature}`;
    await expect(issuer.verify(forged)).rejects.toThrow();
  });

  it("rejects an expired token", async () => {
    const issuer = new SessionIssuer("test-secret", -1); // already expired
    const issued = await issuer.issue({ sub: "GABC123", sellerId: "sel_1" });
    await expect(issuer.verify(issued.token)).rejects.toThrow();
  });

  it("rejects garbage input", async () => {
    const issuer = new SessionIssuer("test-secret");
    await expect(issuer.verify("not-a-jwt")).rejects.toThrow();
  });
});
