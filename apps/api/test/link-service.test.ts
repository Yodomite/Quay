import { describe, expect, it } from "vitest";
import { OffRampJobNotFoundError, type KycPort, type RailPort } from "@checkout/core";
import { MockAnchorOffRamp } from "@checkout/offramp";
import type { StellarConfig } from "@checkout/stellar";
import { LinkService } from "../src/services/link-service";
import {
  AlwaysAcceptedKyc,
  FakeLinkRepository,
  FakeOffRampStateRepository,
  FakeWebhookRepository,
  ScriptedKyc,
  ScriptedOffRamp,
  makeLink,
} from "./fakes";

const STELLAR: StellarConfig = {
  network: "testnet",
  horizonUrl: "https://horizon-testnet.stellar.org",
  networkPassphrase: "Test SDF Network ; September 2015",
  usdcIssuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
};

const UNUSED_RAIL: RailPort = {
  async assertCanReceive() {},
  buildRequest() {
    throw new Error("not used in these tests");
  },
  isValidDestination() {
    return true;
  },
};

function makeService(opts: {
  links: FakeLinkRepository;
  offramp: ScriptedOffRamp | MockAnchorOffRamp;
  offrampState: FakeOffRampStateRepository;
  webhooks?: FakeWebhookRepository;
  kyc?: KycPort;
}): LinkService {
  return new LinkService({
    links: opts.links,
    sellers: {
      getDefault: async () => ({ id: "sel_1", name: "Seller", wallet: "GSELLER", createdAt: 0 }),
      findById: async () => null,
      findByWallet: async () => null,
      createIfAbsent: async () => ({ id: "sel_1", name: "Seller", wallet: "GSELLER", createdAt: 0 }),
    },
    webhooks: opts.webhooks ?? new FakeWebhookRepository(),
    rail: UNUSED_RAIL,
    offramp: opts.offramp,
    offrampState: opts.offrampState,
    kyc: opts.kyc ?? new AlwaysAcceptedKyc(),
    stellar: STELLAR,
    correlation: "memo",
  });
}

describe("LinkService.pollCashOuts", () => {
  it("settles a link when the adapter reports settled", async () => {
    const links = new FakeLinkRepository([
      makeLink({ status: "offramp_pending", offrampJobId: "job_1", offrampStatus: "pending" }),
    ]);
    const offramp = new ScriptedOffRamp();
    offramp.statusImpl = async (jobId) => ({
      jobId,
      linkId: "lnk_1",
      status: "settled",
      targetCurrency: "NGN",
      targetAmount: "16500",
      rate: "1650",
    });

    await makeService({ links, offramp, offrampState: new FakeOffRampStateRepository() }).pollCashOuts();

    expect(links.get("lnk_1")?.status).toBe("offramp_settled");
    expect(links.get("lnk_1")?.offrampStatus).toBe("settled");
  });

  it("moves the link to offramp_failed when status() throws a typed OffRampJobNotFoundError", async () => {
    const links = new FakeLinkRepository([
      makeLink({ status: "offramp_pending", offrampJobId: "job_lost", offrampStatus: "pending" }),
    ]);
    const offramp = new ScriptedOffRamp();
    offramp.statusImpl = async (jobId) => {
      throw new OffRampJobNotFoundError(jobId);
    };

    await makeService({ links, offramp, offrampState: new FakeOffRampStateRepository() }).pollCashOuts();

    expect(links.get("lnk_1")?.status).toBe("offramp_failed");
    expect(links.get("lnk_1")?.offrampStatus).toBe("failed");
  });

  it("leaves the link pending on a transient (non-typed) error, to retry next tick", async () => {
    const links = new FakeLinkRepository([
      makeLink({ status: "offramp_pending", offrampJobId: "job_1", offrampStatus: "pending" }),
    ]);
    const offramp = new ScriptedOffRamp();
    offramp.statusImpl = async () => {
      throw new Error("ECONNRESET");
    };

    await makeService({ links, offramp, offrampState: new FakeOffRampStateRepository() }).pollCashOuts();

    expect(links.get("lnk_1")?.status).toBe("offramp_pending");
  });

  it("fails a link stuck at offramp_pending with no job id at all (can never resolve)", async () => {
    const links = new FakeLinkRepository([
      makeLink({ status: "offramp_pending", offrampJobId: null, offrampStatus: "pending" }),
    ]);
    const offramp = new ScriptedOffRamp();

    await makeService({ links, offramp, offrampState: new FakeOffRampStateRepository() }).pollCashOuts();

    expect(links.get("lnk_1")?.status).toBe("offramp_failed");
  });
});

describe("LinkService.backfillLostOffRampJobs", () => {
  it("fails a link whose job id has no row in the off-ramp state store", async () => {
    const links = new FakeLinkRepository([
      makeLink({ status: "offramp_pending", offrampJobId: "job_never_persisted", offrampStatus: "pending" }),
    ]);
    const offrampState = new FakeOffRampStateRepository();
    const service = makeService({ links, offramp: new ScriptedOffRamp(), offrampState });

    const fixed = await service.backfillLostOffRampJobs();

    expect(fixed).toBe(1);
    expect(links.get("lnk_1")?.status).toBe("offramp_failed");
    expect(links.get("lnk_1")?.offrampStatus).toBe("failed");
  });

  it("leaves a link alone when its job row is present", async () => {
    const links = new FakeLinkRepository([
      makeLink({ status: "offramp_pending", offrampJobId: "job_1", offrampStatus: "pending" }),
    ]);
    const offrampState = new FakeOffRampStateRepository();
    await offrampState.saveJob({
      jobId: "job_1",
      linkId: "lnk_1",
      anchor: "mock",
      targetCurrency: "NGN",
      targetAmount: "16500",
      rate: "1650",
      status: "pending",
      externalStatus: null,
      lastError: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const service = makeService({ links, offramp: new ScriptedOffRamp(), offrampState });

    const fixed = await service.backfillLostOffRampJobs();

    expect(fixed).toBe(0);
    expect(links.get("lnk_1")?.status).toBe("offramp_pending");
  });

  it("does not touch links that aren't offramp_pending", async () => {
    const links = new FakeLinkRepository([makeLink({ status: "paid" })]);
    const service = makeService({ links, offramp: new ScriptedOffRamp(), offrampState: new FakeOffRampStateRepository() });

    const fixed = await service.backfillLostOffRampJobs();

    expect(fixed).toBe(0);
    expect(links.get("lnk_1")?.status).toBe("paid");
  });
});

describe("LinkService.triggerCashOut — KYC gate", () => {
  it("rejects with 403 kyc_required when the seller's KYC isn't ACCEPTED", async () => {
    const links = new FakeLinkRepository([makeLink({ status: "paid" })]);
    const kyc = new ScriptedKyc();
    kyc.statusImpl = async (sellerId) => ({
      sellerId,
      customerId: null,
      status: "NEEDS_INFO",
      requiredFields: [],
      providedFields: {},
      message: null,
      lastSyncedAt: null,
      updatedAt: Date.now(),
    });
    const service = makeService({ links, offramp: new ScriptedOffRamp(), offrampState: new FakeOffRampStateRepository(), kyc });

    await expect(
      service.triggerCashOut("lnk_1", { targetCurrency: "NGN", payoutFields: {} }),
    ).rejects.toMatchObject({ status: 403, message: "kyc_required" });
    // Never reached the off-ramp adapter, and the link stays untouched.
    expect(links.get("lnk_1")?.status).toBe("paid");
  });

  it("proceeds to the off-ramp adapter once KYC is ACCEPTED", async () => {
    const links = new FakeLinkRepository([makeLink({ status: "paid" })]);
    const offrampState = new FakeOffRampStateRepository();
    const offramp = new MockAnchorOffRamp({ state: offrampState, settleAfterMs: 60_000 });
    const service = makeService({ links, offramp, offrampState, kyc: new AlwaysAcceptedKyc() });

    const job = await service.triggerCashOut("lnk_1", { targetCurrency: "NGN", payoutFields: {} });

    expect(job.status).toBe("pending");
    expect(links.get("lnk_1")?.status).toBe("offramp_pending");
  });
});

describe("LinkService + MockAnchorOffRamp — restart survives (integration)", () => {
  it("a cash-out initiated pre-restart still settles once a fresh service/adapter pair polls it", async () => {
    const links = new FakeLinkRepository([makeLink({ status: "paid" })]);
    const offrampState = new FakeOffRampStateRepository();

    // "Pre-restart" process: trigger the cash-out.
    const preRestartOfframp = new MockAnchorOffRamp({ state: offrampState, settleAfterMs: 0 });
    const preRestartService = makeService({ links, offramp: preRestartOfframp, offrampState });
    const job = await preRestartService.triggerCashOut("lnk_1", { targetCurrency: "NGN", payoutFields: {} });

    expect(links.get("lnk_1")?.status).toBe("offramp_pending");
    expect(links.get("lnk_1")?.offrampJobId).toBe(job.jobId);

    // "Restart": brand-new adapter and service instances. Only `links` and
    // `offrampState` — the two persisted stores — carry over.
    const postRestartOfframp = new MockAnchorOffRamp({ state: offrampState, settleAfterMs: 0 });
    const postRestartService = makeService({ links, offramp: postRestartOfframp, offrampState });
    await postRestartService.pollCashOuts();

    expect(links.get("lnk_1")?.status).toBe("offramp_settled");
    expect(links.get("lnk_1")?.offrampStatus).toBe("settled");
  });
});
