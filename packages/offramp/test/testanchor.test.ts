import { Keypair } from "@stellar/stellar-sdk";
import { existsSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TestAnchorOffRamp } from "../src/testanchor";

// These hit the real https://testanchor.stellar.org sandbox. Off by default —
// it's a shared external service, not something CI should depend on. Run with:
//   RUN_LIVE_ANCHOR_TESTS=1 pnpm --filter @checkout/offramp test
//
// In CI (or locally) you can supply a specific funded testnet keypair via
//   SELLER_SECRET_KEY=<secret>  — otherwise a random keypair is used.
const USDC_TESTNET_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const ANCHOR_BASE_URL = "https://testanchor.stellar.org";

function makeKeypair(): Keypair {
  if (process.env.SELLER_SECRET_KEY) {
    return Keypair.fromSecret(process.env.SELLER_SECRET_KEY);
  }
  return Keypair.random();
}

describe("TestAnchorOffRamp (offline)", () => {
  it("quote() rejects native XLM with a clear error before any network call", async () => {
    const offramp = new TestAnchorOffRamp({ sellerKeypair: Keypair.random() });
    await expect(
      offramp.quote({
        sourceAsset: { code: "XLM", issuer: null },
        sourceAmount: "25",
        targetCurrency: "USD",
      }),
    ).rejects.toThrow(/only off-ramps USDC/);
  });
});

describe.skipIf(!process.env.RUN_LIVE_ANCHOR_TESTS)("TestAnchorOffRamp (live)", () => {
  const telemetry: { rate?: string; quoteLatencyMs?: number; withdrawLatencyMs?: number } = {};

  it("SEP-1: stellar.toml is discoverable and lists required anchor services", async () => {
    const res = await fetch(`${ANCHOR_BASE_URL}/.well-known/stellar.toml`);
    expect(res.status).toBe(200);

    const text = await res.text();
    // The anchor must advertise the endpoints the off-ramp depends on.
    expect(text).toContain("WEB_AUTH_ENDPOINT"); // SEP-10
    expect(text).toContain("TRANSFER_SERVER"); // SEP-6
    expect(text).toContain("ANCHOR_QUOTE_SERVER"); // SEP-38
  });

  it("SEP-10 + SEP-38: quote() returns a positive rate with a future expiry and a valid SEP-10 JWT underneath", async () => {
    const offramp = new TestAnchorOffRamp({ sellerKeypair: makeKeypair() });

    const started = Date.now();
    const quote = await offramp.quote({
      sourceAsset: { code: "USDC", issuer: USDC_TESTNET_ISSUER },
      sourceAmount: "10",
      targetCurrency: "USD",
    });
    telemetry.quoteLatencyMs = Date.now() - started;

    expect(Number(quote.rate)).toBeGreaterThan(0);
    expect(quote.expiresAt).toBeGreaterThan(Date.now());
    expect(quote.quoteId).toBeTruthy();

    telemetry.rate = quote.rate;
  });

  it("SEP-6: initiate() then status() completes the request/response round trip", async () => {
    const offramp = new TestAnchorOffRamp({ sellerKeypair: makeKeypair() });

    const quote = await offramp.quote({
      sourceAsset: { code: "USDC", issuer: USDC_TESTNET_ISSUER },
      sourceAmount: "10",
      targetCurrency: "USD",
    });

    const job = await offramp.initiate({
      linkId: "test-link",
      quoteId: quote.quoteId,
      payout: {
        currency: "USD",
        fields: { type: "bank_account", dest: "1234", dest_extra: "021000021" },
      },
    });
    expect(job.jobId).toBeTruthy();

    const pollStarted = Date.now();
    const polled = await offramp.status(job.jobId);
    telemetry.withdrawLatencyMs = Date.now() - pollStarted;

    // Sandbox settlement timing is not deterministic — only assert the shape,
    // never assert eventual "settled".
    expect(["pending", "settled", "failed"]).toContain(polled.status);
  });

  // After all live tests run, emit telemetry for the CI workflow to capture.
  it("emits probe telemetry", () => {
    expect(telemetry.rate).toBeDefined();
    expect(telemetry.quoteLatencyMs).toBeDefined();
    writeFileSync("probe-telemetry.json", JSON.stringify(telemetry, null, 2), "utf-8");
    expect(existsSync("probe-telemetry.json")).toBe(true);
  });
});
