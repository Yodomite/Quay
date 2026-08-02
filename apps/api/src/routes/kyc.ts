import { Hono } from "hono";
import { z } from "zod";
import { KycRequiredError, type KycRecord } from "@checkout/core";
import type { Container } from "../services/container";

const submitKycSchema = z.record(z.string(), z.string());

function toResponse(record: KycRecord) {
  return {
    status: record.status,
    requiredFields: record.requiredFields,
    providedFields: record.providedFields,
    message: record.message,
    lastSyncedAt: record.lastSyncedAt,
  };
}

export function kycRoutes(c: Container): Hono {
  const app = new Hono();

  // Current requirements + status, re-synced from the anchor.
  app.get("/", async (ctx) => {
    const seller = await c.sellers.getDefault();
    const record = await c.kyc.status(seller.id);
    return ctx.json(toResponse(record));
  });

  // Submit or update identity fields. Never accepts a partial submission
  // silently — a known-missing required field is a 422, naming exactly
  // which fields are missing, not a fabricated default.
  app.put("/", async (ctx) => {
    const parsed = submitKycSchema.safeParse(await safeJson(ctx));
    if (!parsed.success) return ctx.json({ error: "invalid_body", issues: parsed.error.issues }, 400);

    const seller = await c.sellers.getDefault();
    try {
      const record = await c.kyc.submit(seller.id, parsed.data);
      return ctx.json(toResponse(record));
    } catch (err) {
      if (err instanceof KycRequiredError) {
        return ctx.json({ error: "kyc_required", missingFields: err.missingFields }, 422);
      }
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
