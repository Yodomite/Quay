import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { rateLimit, MemoryStore, clientIp } from "./rate-limit";

function appWithLimit(max: number, trustProxyHops: number) {
  const app = new Hono();
  app.use("*", rateLimit({ windowMs: 60_000, max, store: new MemoryStore(), trustProxyHops }));
  app.get("/", (ctx) => ctx.json({ ok: true }));
  return app;
}

describe("clientIp", () => {
  it("trusts only the nth entry from the right, not the leftmost", async () => {
    const app = new Hono();
    app.get("/", (ctx) => ctx.json({ ip: clientIp(ctx, 1) }));
    // Chain: [attacker-supplied, real-proxy-appended]. With trustProxyHops=1,
    // the rightmost entry (index length-1) is the one our own proxy set.
    const res = await app.request("/", {
      headers: { "x-forwarded-for": "1.2.3.4, 5.6.7.8" },
    });
    const body = await res.json() as { ip: string };
    expect(body.ip).toBe("5.6.7.8");
  });

  it("ignores x-forwarded-for entirely when trustProxyHops is 0", async () => {
    const app = new Hono();
    app.get("/", (ctx) => ctx.json({ ip: clientIp(ctx, 0) }));
    const res = await app.request("/", {
      headers: { "x-forwarded-for": "1.2.3.4" },
    });
    const body = await res.json() as { ip: string };
    expect(body.ip).not.toBe("1.2.3.4");
  });
});

describe("rateLimit with spoofed x-forwarded-for", () => {
  it("cannot bypass the limit by sending a fresh forged chain per request", async () => {
    const app = appWithLimit(2, 1);

    // Same trusted (rightmost) hop each time — only the untrusted, attacker
    // controlled leftmost entry changes. Because trustProxyHops=1 only looks
    // at the rightmost entry, all three requests must share one counter.
    const req = (spoofed: string) =>
      app.request("/", { headers: { "x-forwarded-for": `${spoofed}, 9.9.9.9` } });

    const r1 = await req("1.1.1.1");
    const r2 = await req("2.2.2.2");
    const r3 = await req("3.3.3.3");

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r3.status).toBe(429);
  });

  it("gives a fresh budget to a genuinely different trusted hop", async () => {
    const app = appWithLimit(1, 1);

    const r1 = await app.request("/", { headers: { "x-forwarded-for": "1.1.1.1, 9.9.9.9" } });
    const r2 = await app.request("/", { headers: { "x-forwarded-for": "2.2.2.2, 8.8.8.8" } });

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
  });
});
