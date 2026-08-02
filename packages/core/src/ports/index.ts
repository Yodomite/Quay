import type { AssetRef, PaymentLink } from "../domain/payment-link";
import type { NormalizedPayment } from "../matching/match-payment";

// ---------------------------------------------------------------------------
// Settlement rail port
// ---------------------------------------------------------------------------
// Builds the payer-facing payment request. The Stellar adapter implements this
// with SEP-7; a different chain would implement it differently — the domain
// never sees chain-specific types.

export interface PaymentRequest {
  uri: string; // e.g. a SEP-7 web+stellar:pay URI
  destination: string;
  amount: string;
  asset: AssetRef;
  memo: string | null; // correlation reference echoed back on-chain; null in muxed mode
}

export interface RailPort {
  /** Build a payment request a wallet can fulfill. */
  buildRequest(input: {
    destination: string;
    amount: string;
    asset: AssetRef;
    reference: string;
    /** SEP-23 muxed id. When present, the rail encodes it into an M-address
     *  destination and omits the memo instead of using MEMO_TEXT correlation. */
    muxedId?: string | null;
    message?: string;
  }): PaymentRequest;

  /** Validate that a string is a usable destination address for this rail. */
  isValidDestination(address: string): boolean;

  /**
   * Throws `CannotReceiveError` if `account` cannot currently receive `asset` —
   * the account doesn't exist yet, or (for issued assets) has no trustline, an
   * unauthorized one, or one already at its limit. Resolves silently if it can.
   * Implementations should cache a short TTL per (account, asset) so calling
   * this on every link creation stays cheap.
   */
  assertCanReceive(account: string, asset: AssetRef): Promise<void>;
}

export type CannotReceiveReason =
  | "account_not_found" // not yet created/funded on-chain
  | "no_trustline" // issued asset, no trustline established
  | "trustline_not_authorized" // trustline exists but the issuer froze/deauthorized it
  | "trustline_limit_exceeded"; // trustline exists but is already full

/** Raised by `RailPort.assertCanReceive`. `trustlineUri` (when present) is a
 *  rail-specific "fix it" deep link — e.g. a SEP-7 `tx` URI wrapping an unsigned
 *  changeTrust operation the seller's wallet can sign directly. */
export class CannotReceiveError extends Error {
  constructor(
    readonly reason: CannotReceiveReason,
    message: string,
    readonly trustlineUri?: string,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Settlement watcher port
// ---------------------------------------------------------------------------
// Pulls new incoming payments for an account since a cursor. Polling keeps the
// MVP restart-safe and simple; a streaming impl can satisfy the same port.

export interface WatcherPort {
  /** Most-recent paging token for an account, used to seed a fresh watch. */
  latestCursor(account: string): Promise<string | null>;

  /** Incoming payments to `account` strictly after `cursor`, oldest-first. */
  fetchSince(account: string, cursor: string, limit?: number): Promise<NormalizedPayment[]>;
}

// ---------------------------------------------------------------------------
// Off-ramp port  ← the seam this whole product is built around
// ---------------------------------------------------------------------------
// `seller_initiated`: the seller receives the stablecoin to their own wallet and
//   later triggers a cash-out. Custody stays at the edges. This is the MVP mode.
// `inline`: value is routed through the anchor mid-flight so the seller receives
//   local currency directly. This is what merchants want — and it is the mode that
//   puts you in the money-transmission / custody bucket. Do not enable it until a
//   licensed anchor relationship and a compliance story are real.
//
// Interface shape mirrors the Stellar SEP standards you'd wire underneath:
//   quote()    ~ SEP-38 (firm FX quote with an expiry; transfers in-flight rate risk)
//   initiate() ~ SEP-24 / SEP-31 (start a withdrawal/payout to local rails)
//   status()   ~ poll the transfer to settlement

export type OffRampMode = "seller_initiated" | "inline";

export interface OffRampQuote {
  quoteId: string;
  sourceAsset: AssetRef;
  sourceAmount: string;
  targetCurrency: string; // ISO code, e.g. "NGN"
  targetAmount: string; // what the seller will receive
  rate: string; // sourceAsset -> targetCurrency
  expiresAt: number; // epoch ms — after this the quote is void
}

/** Where the seller wants their local-currency payout to land. */
export interface SellerPayoutRef {
  currency: string; // "NGN"
  // Opaque to the domain; an anchor adapter interprets these (bank/account,
  // routing, etc.). NOT identity/KYC data — that's `KycPort`, submitted once
  // per seller ahead of time, never derived from a cash-out request.
  fields: Record<string, string>;
}

export type OffRampJobStatus = "pending" | "settled" | "failed";

export interface OffRampJob {
  jobId: string;
  linkId: string;
  status: OffRampJobStatus;
  targetCurrency: string;
  targetAmount: string;
  rate: string;
  reason?: string; // set when failed
}

export interface OffRampPort {
  readonly mode: OffRampMode;
  quote(input: {
    linkId: string;
    sourceAsset: AssetRef;
    sourceAmount: string;
    targetCurrency: string;
  }): Promise<OffRampQuote>;
  initiate(input: { linkId: string; quoteId: string; payout: SellerPayoutRef }): Promise<OffRampJob>;
  /** Throws {@link OffRampJobNotFoundError} when `jobId` has no known state — a
   *  crash/redeploy wiped an in-memory-only implementation, or the id is bogus. */
  status(jobId: string): Promise<OffRampJob>;
}

/** Typed miss for {@link OffRampPort.status}, so callers (the cash-out poller)
 *  can tell "this job's state is genuinely gone" apart from a transient
 *  network/anchor error and act on it — see `OffRampStateRepository`. */
export class OffRampJobNotFoundError extends Error {
  constructor(readonly jobId: string) {
    super(`Unknown off-ramp job: ${jobId}`);
    this.name = "OffRampJobNotFoundError";
  }
}

// ---------------------------------------------------------------------------
// Off-ramp state persistence
// ---------------------------------------------------------------------------
// Quotes and jobs are money-adjacent state: a cash-out sits in `offramp_pending`
// for real seconds-to-days while an anchor settles it, so this cannot live only
// in an adapter's in-process Map — a restart must not strand the seller's money.

export interface StoredOffRampQuote {
  quoteId: string;
  linkId: string;
  sellAsset: AssetRef;
  sellAmount: string;
  buyCurrency: string;
  price: string;
  expiresAt: number;
  createdAt: number;
}

export interface StoredOffRampJob {
  jobId: string;
  linkId: string;
  anchor: string; // which OffRampPort adapter owns this job, e.g. "mock" | "testanchor"
  targetCurrency: string;
  targetAmount: string;
  rate: string;
  status: OffRampJobStatus;
  externalStatus: string | null; // raw upstream status string, for debugging
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface OffRampStateRepository {
  saveQuote(quote: StoredOffRampQuote): Promise<void>;
  getQuote(quoteId: string): Promise<StoredOffRampQuote | null>;
  saveJob(job: StoredOffRampJob): Promise<void>;
  getJob(jobId: string): Promise<StoredOffRampJob | null>;
  updateJob(
    jobId: string,
    patch: Partial<Pick<StoredOffRampJob, "targetAmount" | "status" | "externalStatus" | "lastError">>,
  ): Promise<void>;
}

// ---------------------------------------------------------------------------
// KYC port (SEP-12)
// ---------------------------------------------------------------------------
// No real anchor will pay out against fabricated identity data, so this is
// modeled as its own lifecycle — separate from a cash-out request — keyed by
// seller, never by link: one seller can hold many links, but their identity
// is submitted once and reused. `seller_initiated` mode still needs it for
// the anchor's own compliance requirements, even though custody never moves
// through us.

export type KycStatus = "unsubmitted" | "NEEDS_INFO" | "PROCESSING" | "ACCEPTED" | "REJECTED";

export interface KycFieldSpec {
  name: string; // e.g. "first_name"
  type: string; // anchor-defined: "string" | "date" | "binary" | "number" | ...
  description?: string;
  optional: boolean;
  choices?: string[];
}

export interface KycRecord {
  sellerId: string;
  /** Anchor-assigned customer id, once one exists — reused on later GET/PUT
   *  calls instead of re-resolving by account, per SEP-12. */
  customerId: string | null;
  status: KycStatus;
  /** Latest field requirements discovered from the anchor. Empty once ACCEPTED. */
  requiredFields: KycFieldSpec[];
  /** Values we have on file for this seller. PII — never log, never put on a
   *  webhook payload or a `/links` response; encrypted at rest by the repo. */
  providedFields: Record<string, string>;
  /** Anchor's status/rejection message, verbatim. */
  message: string | null;
  lastSyncedAt: number | null;
  updatedAt: number;
}

/** Thrown by {@link KycPort.submit} when required fields are missing, naming
 *  exactly which ones — the API layer maps this to `422 kyc_required`. */
export class KycRequiredError extends Error {
  constructor(readonly missingFields: string[]) {
    super(`Missing required KYC fields: ${missingFields.join(", ")}`);
    this.name = "KycRequiredError";
  }
}

export interface KycPort {
  /** Refreshes from the anchor (if applicable) and persists the result. */
  status(sellerId: string): Promise<KycRecord>;
  /** Submits/updates fields. Throws {@link KycRequiredError} if a required
   *  field is still missing after merging with what's already on file. */
  submit(sellerId: string, fields: Record<string, string>): Promise<KycRecord>;
}

/** Persistence for `KycRecord`, keyed by seller. `providedFields` is PII and
 *  must be encrypted at rest by the implementation. */
export interface KycRepository {
  get(sellerId: string): Promise<KycRecord | null>;
  save(record: KycRecord): Promise<void>;
}

// ---------------------------------------------------------------------------
// Repository ports
// ---------------------------------------------------------------------------

export interface CreateLinkInput {
  id: string;
  reference: string;
  sellerId: string;
  destination: string;
  muxedId: string | null;
  title: string;
  amount: string;
  asset: AssetRef;
  expiresAt: number | null;
}

export interface LinkRepository {
  create(input: CreateLinkInput): Promise<PaymentLink>;
  findById(id: string): Promise<PaymentLink | null>;
  findByReference(reference: string): Promise<PaymentLink | null>;
  listBySeller(sellerId: string): Promise<PaymentLink[]>;
  /** All links currently in a given status (used by the cash-out poller). */
  listByStatus(status: PaymentLink["status"]): Promise<PaymentLink[]>;
  /** Distinct destination addresses that currently have at least one active link. */
  activeDestinations(): Promise<string[]>;
  /** Active (or underpaid) links whose value lands in `destination`. */
  openLinksForDestination(destination: string): Promise<PaymentLink[]>;
  save(link: PaymentLink): Promise<void>;
}

export interface Seller {
  id: string;
  name: string;
  wallet: string;
  createdAt: number;
}

export interface SellerRepository {
  getDefault(): Promise<Seller>;
  findById(id: string): Promise<Seller | null>;
  findByWallet(wallet: string): Promise<Seller | null>;
  /** Wallet-native signup: SEP-10 proved control of `wallet`, so it IS the identity.
   *  Idempotent — returns the existing seller if one is already registered for it. */
  createIfAbsent(wallet: string): Promise<Seller>;
}

export interface Webhook {
  id: string;
  sellerId: string;
  url: string;
  secret: string;
  createdAt: number;
}

export interface WebhookDelivery {
  webhookId: string;
  linkId: string;
  event: string;
  statusCode: number | null;
  ok: boolean;
  error: string | null;
}

export interface WebhookRepository {
  create(input: { sellerId: string; url: string; secret: string }): Promise<Webhook>;
  listBySeller(sellerId: string): Promise<Webhook[]>;
  recordDelivery(d: WebhookDelivery): Promise<void>;
}

/** Watcher bookkeeping: per-account cursor + processed-tx ledger for idempotency. */
export interface WatcherStateRepository {
  getCursor(account: string): Promise<string | null>;
  setCursor(account: string, cursor: string): Promise<void>;
  isProcessed(txHash: string): Promise<boolean>;
  markProcessed(txHash: string, linkId: string | null): Promise<void>;
}

/** Session-JWT revocation, keyed by the token's own `jti` — logout and
 *  compromise both work by revoking a specific token id, not by invalidating
 *  every session for a seller. */
export interface TokenRevocationRepository {
  /** `expiresAt` (epoch seconds) mirrors the token's own `exp`, so expired
   *  revocation rows can be swept without ever affecting still-valid tokens. */
  revoke(jti: string, expiresAt: number): Promise<void>;
  isRevoked(jti: string): Promise<boolean>;
  /** Deletes revocation rows whose token would already fail verification on
   *  expiry alone — safe to call opportunistically, no correctness impact. */
  sweepExpired(now: number): Promise<void>;
}
