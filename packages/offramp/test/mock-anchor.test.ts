import { describe, expect, it } from "vitest";
import { OffRampJobNotFoundError } from "@checkout/core";
import { MockAnchorOffRamp } from "../src/mock-anchor";
import { FakeOffRampStateRepository } from "./fake-state";

const USDC = { code: "USDC", issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5" };

describe("MockAnchorOffRamp", () => {
  it("quotes, initiates, and settles after settleAfterMs", async () => {
    const state = new FakeOffRampStateRepository();
    const offramp = new MockAnchorOffRamp({ state, settleAfterMs: 0 });

    const quote = await offramp.quote({
      linkId: "lnk_1",
      sourceAsset: USDC,
      sourceAmount: "10",
      targetCurrency: "NGN",
    });
    expect(Number(quote.targetAmount)).toBeGreaterThan(0);

    const job = await offramp.initiate({
      linkId: "lnk_1",
      quoteId: quote.quoteId,
      payout: { currency: "NGN", fields: {} },
    });
    expect(job.status).toBe("pending");

    const polled = await offramp.status(job.jobId);
    expect(polled.status).toBe("settled");
    expect(polled.targetAmount).toBe(quote.targetAmount);
  });

  it("fails the job when alwaysFail is set, with a reason", async () => {
    const offramp = new MockAnchorOffRamp({
      state: new FakeOffRampStateRepository(),
      settleAfterMs: 0,
      alwaysFail: true,
    });
    const quote = await offramp.quote({ linkId: "lnk_1", sourceAsset: USDC, sourceAmount: "10", targetCurrency: "NGN" });
    const job = await offramp.initiate({ linkId: "lnk_1", quoteId: quote.quoteId, payout: { currency: "NGN", fields: {} } });

    const polled = await offramp.status(job.jobId);
    expect(polled.status).toBe("failed");
    expect(polled.reason).toBeTruthy();
  });

  it("rejects an unknown target currency", async () => {
    const offramp = new MockAnchorOffRamp({ state: new FakeOffRampStateRepository() });
    await expect(
      offramp.quote({ linkId: "lnk_1", sourceAsset: USDC, sourceAmount: "10", targetCurrency: "ZZZ" }),
    ).rejects.toThrow(/no rate/);
  });

  it("rejects initiate() with an unknown or expired quote id", async () => {
    const offramp = new MockAnchorOffRamp({ state: new FakeOffRampStateRepository() });
    await expect(
      offramp.initiate({ linkId: "lnk_1", quoteId: "bogus", payout: { currency: "NGN", fields: {} } }),
    ).rejects.toThrow(/Unknown or expired quote/);
  });

  it("status() throws a typed OffRampJobNotFoundError for an unknown job id", async () => {
    const offramp = new MockAnchorOffRamp({ state: new FakeOffRampStateRepository() });
    await expect(offramp.status("no-such-job")).rejects.toBeInstanceOf(OffRampJobNotFoundError);
  });

  it("a fresh adapter instance sharing only the persisted state resolves status() (restart simulation)", async () => {
    const state = new FakeOffRampStateRepository();
    const preRestart = new MockAnchorOffRamp({ state, settleAfterMs: 0 });

    const quote = await preRestart.quote({
      linkId: "lnk_1",
      sourceAsset: USDC,
      sourceAmount: "10",
      targetCurrency: "NGN",
    });
    const job = await preRestart.initiate({
      linkId: "lnk_1",
      quoteId: quote.quoteId,
      payout: { currency: "NGN", fields: {} },
    });

    // Simulates a redeploy: brand-new adapter instance, same backing store.
    // Pre-fix (in-memory Maps) this would throw "Unknown off-ramp job" forever.
    const postRestart = new MockAnchorOffRamp({ state, settleAfterMs: 0 });
    const polled = await postRestart.status(job.jobId);
    expect(polled.status).toBe("settled");
    expect(polled.jobId).toBe(job.jobId);
    expect(polled.linkId).toBe("lnk_1");
  });

  it("settling is idempotent: polling again after settlement doesn't change the outcome", async () => {
    const state = new FakeOffRampStateRepository();
    const offramp = new MockAnchorOffRamp({ state, settleAfterMs: 0 });
    const quote = await offramp.quote({ linkId: "lnk_1", sourceAsset: USDC, sourceAmount: "10", targetCurrency: "NGN" });
    const job = await offramp.initiate({ linkId: "lnk_1", quoteId: quote.quoteId, payout: { currency: "NGN", fields: {} } });

    const first = await offramp.status(job.jobId);
    const second = await offramp.status(job.jobId);
    expect(first.status).toBe("settled");
    expect(second).toEqual(first);
  });
});
