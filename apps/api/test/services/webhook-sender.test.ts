import { describe, it, expect, beforeAll, afterAll, vi, beforeEach, afterEach } from "vitest";
import { createHmac, randomBytes } from "node:crypto";
import { WebhookSender } from "../../src/services/webhook-sender";
import { DrizzleWebhookRepository } from "../../src/repos/index";
import { withTestDb } from "../setup";
import type { DB } from "../../src/db/client";
import type { Client } from "@libsql/client";
import { webhookDeliveries } from "../../src/db/schema";
import { eq } from "drizzle-orm";

// ---------------------------------------------------------------------------
//  Webhook sender tests — all delivery is mocked via vi.spyOn(globalThis, "fetch")
// ---------------------------------------------------------------------------

describe("WebhookSender", () => {
  let db: DB;
  let client: Client;
  let repo: DrizzleWebhookRepository;
  let sender: WebhookSender;
  let hook: { id: string; sellerId: string; url: string; secret: string; createdAt: number };

  beforeAll(async () => {
    const repos = await withTestDb();
    db = repos.db;
    client = repos.client;
    repo = repos.webhooks;
  });

  afterAll(() => {
    client.close();
  });

  beforeEach(async () => {
    sender = new WebhookSender(repo, {
      maxAttempts: 2,
      baseDelayMs: 10,
      timeoutMs: 2000,
    });

    hook = await repo.create({
      sellerId: "sel_test",
      url: "http://localhost:1",
      secret: randomBytes(24).toString("hex"),
    });
  });

  // -----------------------------------------------------------------------
  //  Signature verification
  // -----------------------------------------------------------------------

  describe("signature verification", () => {
    it("computes a verifiable HMAC-SHA256 signature", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(null, { status: 200 }),
      );

      await sender.dispatch([hook], "lnk_test", {
        event: "link.paid",
        data: { linkId: "lnk_test", status: "paid", amount: "10" },
      });

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const call = fetchSpy.mock.calls[0]!;
      const headers = call[1]!.headers as Record<string, string>;
      const signatureHeader = headers["x-checkout-signature"] as string;

      expect(signatureHeader).toMatch(/^sha256=/);
      const sigValue = signatureHeader.replace("sha256=", "");
      const body = call[1]!.body as string;

      const expectedSig = createHmac("sha256", hook.secret).update(body).digest("hex");
      expect(sigValue).toBe(expectedSig);

      expect(headers["x-checkout-event"]).toBe("link.paid");

      fetchSpy.mockRestore();
    });

    it("includes sentAt within the signed body for replay protection", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(null, { status: 200 }),
      );

      await sender.dispatch([hook], "lnk_test", {
        event: "link.paid",
        data: {},
      });

      const call = fetchSpy.mock.calls[0]!;
      const body = JSON.parse(call[1]!.body as string);
      expect(body.sentAt).toBeDefined();
      expect(() => new Date(body.sentAt)).not.toThrow();

      const sigHeader = (call[1]!.headers as Record<string, string>)["x-checkout-signature"]!;
      const tamperedBody = JSON.stringify({ ...body, sentAt: "2020-01-01T00:00:00.000Z" });
      const tamperedSig = createHmac("sha256", hook.secret).update(tamperedBody).digest("hex");
      expect(tamperedSig).not.toBe(sigHeader.replace("sha256=", ""));

      fetchSpy.mockRestore();
    });

    it("includes the event id and event name in the body", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(null, { status: 200 }),
      );

      await sender.dispatch([hook], "lnk_abc123", {
        event: "link.paid",
        data: { key: "val" },
      });

      const call = fetchSpy.mock.calls[0]!;
      const body = JSON.parse(call[1]!.body as string);
      expect(body.id).toBe("lnk_abc123");
      expect(body.event).toBe("link.paid");
      expect(body.data.key).toBe("val");

      fetchSpy.mockRestore();
    });
  });

  // -----------------------------------------------------------------------
  //  Retry logic
  // -----------------------------------------------------------------------

  describe("retry logic", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("retries on 5xx up to maxAttempts", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response(null, { status: 500 }));

      await sender.dispatch([hook], "lnk_retry", {
        event: "link.paid",
        data: {},
      });

      // maxAttempts=2, both return 500 -> 2 fetch calls
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it("retries then succeeds and records delivery as ok", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(new Response(null, { status: 500 }))
        .mockResolvedValueOnce(new Response(null, { status: 200 }));

      await sender.dispatch([hook], "lnk_retry_ok", {
        event: "link.paid",
        data: {},
      });

      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it("does NOT retry on 4xx (client error)", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response(null, { status: 400 }));

      await sender.dispatch([hook], "lnk_4xx", {
        event: "link.paid",
        data: {},
      });

      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it("does NOT retry on 404", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response(null, { status: 404 }));

      await sender.dispatch([hook], "lnk_404", {
        event: "link.paid",
        data: {},
      });

      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it("retries on 429 (rate-limited) as it's transient", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(new Response(null, { status: 429 }))
        .mockResolvedValueOnce(new Response(null, { status: 200 }));

      await sender.dispatch([hook], "lnk_429", {
        event: "link.paid",
        data: {},
      });

      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it("retries on network error", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch")
        .mockRejectedValueOnce(new Error("ECONNREFUSED"))
        .mockRejectedValueOnce(new Error("ECONNREFUSED"));

      await sender.dispatch([hook], "lnk_netfail", {
        event: "link.paid",
        data: {},
      });

      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });
  });

  // -----------------------------------------------------------------------
  //  Delivery rows — query the DB to verify persistence
  // -----------------------------------------------------------------------

  describe("delivery rows", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("records a delivery row with success info", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(null, { status: 200 }),
      );

      await sender.dispatch([hook], "lnk_del_success", {
        event: "link.paid",
        data: {},
      });

      const rows = await db.select().from(webhookDeliveries)
        .where(eq(webhookDeliveries.linkId, "lnk_del_success"));

      expect(rows.length).toBe(1);
      expect(rows[0]!.webhookId).toBe(hook.id);
      expect(rows[0]!.linkId).toBe("lnk_del_success");
      expect(rows[0]!.event).toBe("link.paid");
      expect(rows[0]!.statusCode).toBe(200);
      expect(rows[0]!.ok).toBe(true);
      expect(rows[0]!.error).toBeNull();
    });

    it("records a delivery row with error info when all attempts fail", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(null, { status: 500 }),
      );

      await sender.dispatch([hook], "lnk_del_fail", {
        event: "link.paid",
        data: {},
      });

      const rows = await db.select().from(webhookDeliveries)
        .where(eq(webhookDeliveries.linkId, "lnk_del_fail"));

      expect(rows.length).toBe(1);
      expect(rows[0]!.ok).toBe(false);
      expect(rows[0]!.statusCode).toBe(500);
      expect(rows[0]!.error).toBe("HTTP 500");
    });

    it("records a delivery row for a 400 (non-retried) response", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(null, { status: 400 }),
      );

      await sender.dispatch([hook], "lnk_del_400", {
        event: "link.paid",
        data: {},
      });

      const rows = await db.select().from(webhookDeliveries)
        .where(eq(webhookDeliveries.linkId, "lnk_del_400"));

      expect(rows.length).toBe(1);
      expect(rows[0]!.ok).toBe(false);
      expect(rows[0]!.statusCode).toBe(400);
    });

    it("records delivery for retry-then-success scenario", async () => {
      vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(new Response(null, { status: 500 }))
        .mockResolvedValueOnce(new Response(null, { status: 200 }));

      await sender.dispatch([hook], "lnk_del_retry", {
        event: "link.paid",
        data: {},
      });

      const rows = await db.select().from(webhookDeliveries)
        .where(eq(webhookDeliveries.linkId, "lnk_del_retry"));

      // Only the final outcome is recorded
      expect(rows.length).toBe(1);
      expect(rows[0]!.ok).toBe(true);
      expect(rows[0]!.statusCode).toBe(200);
    });
  });

  // -----------------------------------------------------------------------
  //  Delivery to multiple webhooks
  // -----------------------------------------------------------------------

  describe("delivery to multiple webhooks", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("dispatches to all registered webhooks in parallel", async () => {
      const hook2 = await repo.create({
        sellerId: "sel_test",
        url: "http://localhost:2",
        secret: randomBytes(24).toString("hex"),
      });

      const fetchSpy = vi.spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response(null, { status: 200 }));

      await sender.dispatch([hook, hook2], "lnk_multi", {
        event: "link.paid",
        data: {},
      });

      expect(fetchSpy).toHaveBeenCalledTimes(2);
      const urls = fetchSpy.mock.calls.map((c) => c[0]);
      expect(urls).toContain("http://localhost:1");
      expect(urls).toContain("http://localhost:2");
    });
  });
});

// -----------------------------------------------------------------------
//  Real HTTP server tests — verify end-to-end delivery without mocking fetch
// -----------------------------------------------------------------------

describe("WebhookSender with real HTTP server", () => {
  let db: DB;
  let client: Client;
  let repo: DrizzleWebhookRepository;
  let sender: WebhookSender;

  beforeAll(async () => {
    const repos = await withTestDb();
    db = repos.db;
    client = repos.client;
    repo = repos.webhooks;
  });

  afterAll(() => {
    client.close();
  });

  it("delivers to a real HTTP server and verifies signature", async () => {
    sender = new WebhookSender(repo, { maxAttempts: 1, timeoutMs: 8000 });
    const secret = randomBytes(24).toString("hex");
    const hook = await repo.create({
      sellerId: "sel_test",
      url: "",
      secret,
    });

    // Start a real server to receive the webhook
    let receivedBody = "";
    let receivedHeaders: Record<string, string> = {};
    const { createServer } = await import("node:http");
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c: string) => (body += c));
      req.on("end", () => {
        receivedBody = body;
        receivedHeaders = {};
        for (const [k, v] of Object.entries(req.headers)) {
          if (v) receivedHeaders[k] = Array.isArray(v) ? v.join(", ") : v;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    hook.url = `http://127.0.0.1:${port}`;

    await sender.dispatch([hook], "lnk_real_http", {
      event: "link.paid",
      data: { linkId: "lnk_real_http" },
    });

    server.close();

    // Verify the receiver got the event
    expect(receivedBody).toBeTruthy();
    const parsed = JSON.parse(receivedBody);
    expect(parsed.event).toBe("link.paid");
    expect(parsed.id).toBe("lnk_real_http");

    // Verify the signature is verifiable
    const sigHeader = receivedHeaders["x-checkout-signature"] || "";
    expect(sigHeader).toMatch(/^sha256=/);
    const sigValue = sigHeader.replace("sha256=", "");
    const expectedSig = createHmac("sha256", secret).update(receivedBody).digest("hex");
    expect(sigValue).toBe(expectedSig);

    // Verify delivery was recorded in the DB
    const rows = await db.select().from(webhookDeliveries)
      .where(eq(webhookDeliveries.linkId, "lnk_real_http"));
    expect(rows.length).toBe(1);
    expect(rows[0]!.ok).toBe(true);
  });

  it("does not retry when server returns 400", async () => {
    sender = new WebhookSender(repo, { maxAttempts: 2, timeoutMs: 8000 });
    const hook = await repo.create({
      sellerId: "sel_test",
      url: "",
      secret: randomBytes(24).toString("hex"),
    });

    let callCount = 0;
    const { createServer } = await import("node:http");
    const server = createServer((_req, res) => {
      callCount++;
      res.writeHead(400);
      res.end("Bad request");
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    hook.url = `http://127.0.0.1:${port}`;

    await sender.dispatch([hook], "lnk_400_real_http", {
      event: "link.paid",
      data: {},
    });

    server.close();

    // 4xx is not retried, so only 1 call
    expect(callCount).toBe(1);
  });
});
