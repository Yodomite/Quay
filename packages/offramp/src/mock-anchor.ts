import {
  OffRampJobNotFoundError,
  type AssetRef,
  type OffRampJob,
  type OffRampMode,
  type OffRampPort,
  type OffRampQuote,
  type OffRampStateRepository,
  type SellerPayoutRef,
} from "@checkout/core";

// ===========================================================================
//  MOCK ANCHOR — NOT A REAL OFF-RAMP.
// ===========================================================================
// This exists so the cash-out seam can be wired and demoed end-to-end before a
// licensed anchor relationship exists. It runs in `seller_initiated` mode:
// the seller already holds the stablecoin in their own wallet, and this just
// simulates quoting an FX rate and "paying out" local currency.
//
// To go live, replace this with an adapter that implements the same OffRampPort
// against a real Nigerian anchor's SEP endpoints:
//   quote()    -> SEP-38 POST /quote  (firm rate + expiry; moves in-flight FX risk)
//   initiate() -> SEP-24 interactive withdraw, or SEP-31 send  (start the payout)
//   status()   -> poll the transfer to settlement
//
// Do NOT promote this to `inline` mode without legal review: inline routing means
// value moves through the anchor mid-flight, which is the money-transmission /
// custody box. Keep custody at the edges until that story is real.
//
// Quotes and jobs are persisted through `OffRampStateRepository` rather than
// kept in a Map — this is money-adjacent state that must survive a restart,
// same as the real anchor adapter.

const ANCHOR_NAME = "mock";

const MOCK_RATES: Record<string, number> = {
  // 1 USDC -> X local units. Illustrative only.
  NGN: 1650,
  KES: 129,
  GHS: 15.5,
};

export interface MockAnchorOptions {
  state: OffRampStateRepository;
  /** ms before a quote expires (default 5 min). */
  quoteTtlMs?: number;
  /** ms after initiate() before the job flips to "settled" (default 8s, for demo). */
  settleAfterMs?: number;
  /** force every payout to fail, to exercise the retry path. */
  alwaysFail?: boolean;
}

export class MockAnchorOffRamp implements OffRampPort {
  readonly mode: OffRampMode = "seller_initiated";

  private readonly state: OffRampStateRepository;
  private readonly quoteTtlMs: number;
  private readonly settleAfterMs: number;
  private readonly alwaysFail: boolean;

  constructor(opts: MockAnchorOptions) {
    this.state = opts.state;
    this.quoteTtlMs = opts.quoteTtlMs ?? 5 * 60_000;
    this.settleAfterMs = opts.settleAfterMs ?? 8_000;
    this.alwaysFail = opts.alwaysFail ?? false;
  }

  async quote(input: {
    linkId: string;
    sourceAsset: AssetRef;
    sourceAmount: string;
    targetCurrency: string;
  }): Promise<OffRampQuote> {
    const rate = MOCK_RATES[input.targetCurrency];
    if (rate === undefined) {
      throw new Error(`Mock anchor has no rate for ${input.targetCurrency}`);
    }
    const targetAmount = (Number(input.sourceAmount) * rate).toFixed(2);
    const quoteId = id("quote");
    const now = Date.now();
    const expiresAt = now + this.quoteTtlMs;

    await this.state.saveQuote({
      quoteId,
      linkId: input.linkId,
      sellAsset: input.sourceAsset,
      sellAmount: input.sourceAmount,
      buyCurrency: input.targetCurrency,
      price: String(rate),
      expiresAt,
      createdAt: now,
    });

    return {
      quoteId,
      sourceAsset: input.sourceAsset,
      sourceAmount: input.sourceAmount,
      targetCurrency: input.targetCurrency,
      targetAmount,
      rate: String(rate),
      expiresAt,
    };
  }

  async initiate(input: {
    linkId: string;
    quoteId: string;
    payout: SellerPayoutRef;
  }): Promise<OffRampJob> {
    const q = await this.state.getQuote(input.quoteId);
    if (!q) throw new Error("Unknown or expired quote");
    if (Date.now() > q.expiresAt) throw new Error("Quote expired");

    const targetAmount = (Number(q.sellAmount) * Number(q.price)).toFixed(2);
    const jobId = id("ofr");
    const now = Date.now();

    await this.state.saveJob({
      jobId,
      linkId: input.linkId,
      anchor: ANCHOR_NAME,
      targetCurrency: q.buyCurrency,
      targetAmount,
      rate: q.price,
      status: "pending",
      externalStatus: null,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    });

    return {
      jobId,
      linkId: input.linkId,
      status: "pending",
      targetCurrency: q.buyCurrency,
      targetAmount,
      rate: q.price,
    };
  }

  async status(jobId: string): Promise<OffRampJob> {
    const job = await this.state.getJob(jobId);
    if (!job) throw new OffRampJobNotFoundError(jobId);

    let status = job.status;
    let lastError = job.lastError;
    if (status === "pending" && Date.now() - job.createdAt >= this.settleAfterMs) {
      status = this.alwaysFail ? "failed" : "settled";
      lastError = status === "failed" ? "mock anchor: simulated payout failure" : null;
      await this.state.updateJob(jobId, { status, lastError });
    }

    return {
      jobId,
      linkId: job.linkId,
      status,
      targetCurrency: job.targetCurrency,
      targetAmount: job.targetAmount,
      rate: job.rate,
      reason: lastError ?? undefined,
    };
  }
}

function id(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 12)}`;
}
