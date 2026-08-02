import type { Keypair } from "@stellar/stellar-sdk";
import {
  OffRampJobNotFoundError,
  type AssetRef,
  type OffRampJob,
  type OffRampJobStatus,
  type OffRampMode,
  type OffRampPort,
  type OffRampQuote,
  type OffRampStateRepository,
  type SellerPayoutRef,
} from "@checkout/core";
import { Sep10Client } from "./sep10";
import { getSep38Quote } from "./sep38";
import { getSep6Transaction, startSep6Withdraw } from "./sep6";

// ===========================================================================
//  REAL ANCHOR — SEP-10 (auth) -> SEP-38 (quote) -> SEP-6 (withdraw).
// ===========================================================================
// Talks to the public Stellar testnet reference anchor by default. Same
// `OffRampPort` contract as MockAnchorOffRamp, `seller_initiated` mode: the
// seller already holds the stablecoin, this only quotes an FX rate and drives
// a real off-chain withdrawal to local/bank rails via the anchor's SEP-6 flow.
//
// SEP-24 (interactive) was considered instead of SEP-6 and rejected: the port
// is backend-only today (no interactive-redirect concept anywhere upstream of
// this adapter), while SEP-6 is fully field-driven and needs no changes to
// LinkService, the API routes, or the dashboard.
//
// Quotes and jobs are persisted through `OffRampStateRepository` rather than
// kept in a Map — this is money-adjacent state that must survive a restart.
//
// SEP-12 KYC is deliberately NOT done here: `TestAnchorKyc` (kyc.ts) owns that
// lifecycle, keyed by seller and submitted ahead of time through /seller/kyc.
// `initiate()` assumes the caller (LinkService) already confirmed the seller's
// KYC status is ACCEPTED — this adapter has no business fabricating identity
// fields from whatever happened to be in a cash-out request.

const ANCHOR_NAME = "testanchor";
const DEFAULT_BASE_URL = "https://testanchor.stellar.org";
const DEFAULT_HOME_DOMAIN = "testanchor.stellar.org";

export interface TestAnchorOptions {
  /** Seller's Stellar keypair — SEP-10 needs the secret key to sign the auth challenge. */
  sellerKeypair: Keypair;
  state: OffRampStateRepository;
  baseUrl?: string;
  homeDomain?: string;
}

function mapSep6Status(status: string): OffRampJobStatus {
  if (status === "completed") return "settled";
  if (status === "error" || status === "refunded" || status === "expired") return "failed";
  return "pending"; // pending_anchor, pending_user_transfer_start, pending_external, ...
}

export class TestAnchorOffRamp implements OffRampPort {
  readonly mode: OffRampMode = "seller_initiated";

  private readonly baseUrl: string;
  private readonly auth: Sep10Client;
  private readonly state: OffRampStateRepository;

  constructor(opts: TestAnchorOptions) {
    this.baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
    this.state = opts.state;
    this.auth = new Sep10Client(opts.sellerKeypair, {
      baseUrl: this.baseUrl,
      homeDomain: opts.homeDomain ?? DEFAULT_HOME_DOMAIN,
    });
  }

  async quote(input: {
    linkId: string;
    sourceAsset: AssetRef;
    sourceAmount: string;
    targetCurrency: string;
  }): Promise<OffRampQuote> {
    if (input.sourceAsset.issuer === null) {
      throw new Error(
        'The test anchor only off-ramps USDC — create the link with assetCode "USDC" to cash out.',
      );
    }
    const jwt = await this.auth.token();
    const q = await getSep38Quote(this.baseUrl, jwt, {
      sellAsset: input.sourceAsset,
      sellAmount: input.sourceAmount,
      buyCurrency: input.targetCurrency,
    });

    const expiresAt = Date.parse(q.expiresAt);
    await this.state.saveQuote({
      quoteId: q.id,
      linkId: input.linkId,
      sellAsset: input.sourceAsset,
      sellAmount: input.sourceAmount,
      buyCurrency: input.targetCurrency,
      price: q.price,
      expiresAt,
      createdAt: Date.now(),
    });

    return {
      quoteId: q.id,
      sourceAsset: input.sourceAsset,
      sourceAmount: input.sourceAmount,
      targetCurrency: input.targetCurrency,
      targetAmount: q.buyAmount,
      rate: q.price,
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

    const jwt = await this.auth.token();

    const withdraw = await startSep6Withdraw(this.baseUrl, jwt, {
      assetCode: q.sellAsset.code,
      amount: q.sellAmount,
      account: this.auth.publicKey,
      type: input.payout.fields.type ?? "bank_account",
      dest: input.payout.fields.dest,
      destExtra: input.payout.fields.dest_extra,
    });

    const now = Date.now();
    await this.state.saveJob({
      jobId: withdraw.id,
      linkId: input.linkId,
      anchor: ANCHOR_NAME,
      targetCurrency: q.buyCurrency,
      targetAmount: "",
      rate: q.price,
      status: "pending",
      externalStatus: null,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    });

    return {
      jobId: withdraw.id,
      linkId: input.linkId,
      status: "pending",
      targetCurrency: q.buyCurrency,
      targetAmount: "",
      rate: q.price,
    };
  }

  async status(jobId: string): Promise<OffRampJob> {
    const job = await this.state.getJob(jobId);
    if (!job) throw new OffRampJobNotFoundError(jobId);

    const jwt = await this.auth.token();
    const tx = await getSep6Transaction(this.baseUrl, jwt, jobId);
    const status = mapSep6Status(tx.status);
    const targetAmount = tx.amountOut ?? job.targetAmount;
    const reason = status === "failed" ? (tx.message ?? "testanchor: withdrawal failed") : null;

    await this.state.updateJob(jobId, {
      targetAmount,
      status,
      externalStatus: tx.status,
      lastError: reason,
    });

    return {
      jobId,
      linkId: job.linkId,
      status,
      targetCurrency: job.targetCurrency,
      targetAmount,
      rate: job.rate,
      reason: reason ?? undefined,
    };
  }
}
