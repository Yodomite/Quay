import {
  canTransition,
  normalizeAmount,
  type CashOutBody,
  type CreateLinkBody,
  type LinkRepository,
  type MatchOutcome,
  type NormalizedPayment,
  type OffRampJob,
  type OffRampQuote,
  type OffRampPort,
  type PaymentLink,
  type PaymentRequest,
  type RailPort,
  type SellerRepository,
  type WebhookRepository,
} from "@checkout/core";
import { resolveAsset, type StellarConfig } from "@checkout/stellar";
import { newId, newReference } from "./ids";
import { WebhookSender } from "./webhook-sender";

export interface LinkWithRequest {
  link: PaymentLink;
  request: PaymentRequest;
}

// ---------------------------------------------------------------------------
// AnchorHealth — background probe + circuit breaker (issue #19, 3.7).
// ---------------------------------------------------------------------------
// A live `AnchorHealth` distinguishes a dead anchor from a slow one. A
// background timer pings TOML + SEP-10 + /info every `intervalMs`. After
// `failureThreshold` consecutive failures the breaker opens; while open,
// `triggerCashOut` fails fast with 503 "anchor_unavailable" instead of
// hammering a dead endpoint. After `cooldownMs` the breaker transitions to
// `half_open` and the very next probe decides whether we go back to `closed`
// (success) or stay `open` (another failure).

export type CircuitState = "closed" | "open" | "half_open";

export interface AnchorHealthSnapshot {
  state: CircuitState;
  consecutiveFailures: number;
  lastCheckedAt: number | null;
  lastSuccessAt: number | null;
  lastError: string | null;
  url: string | null;
  probes: { toml: boolean; sep10: boolean; info: boolean };
}

export interface AnchorProbeConfig {
  /** When false (mock mode), `probe()` short-circuits to a success without any network IO. */
  enabled: boolean;
  /** Anchor base URL (e.g. https://testanchor.stellar.org). */
  url: string | null;
  /** Home domain used for TOML and SEP-10. */
  homeDomain: string | null;
  /** Defaults to 3. */
  failureThreshold?: number;
  /** Defaults to 30_000 ms. */
  cooldownMs?: number;
  /** Defaults to 5_000 ms per individual probe HTTP call. */
  requestTimeoutMs?: number;
}

export class AnchorHealth {
  private state: CircuitState = "closed";
  private consecutiveFailures = 0;
  private openedAt: number | null = null;
  private lastCheckedAt: number | null = null;
  private lastSuccessAt: number | null = null;
  private lastError: string | null = null;
  private probes = { toml: false, sep10: false, info: false };

  private readonly enabled: boolean;
  private readonly url: string | null;
  private readonly homeDomain: string | null;
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly requestTimeoutMs: number;

  constructor(cfg: AnchorProbeConfig) {
    this.enabled = cfg.enabled;
    this.url = cfg.url;
    this.homeDomain = cfg.homeDomain;
    this.failureThreshold = cfg.failureThreshold ?? 3;
    this.cooldownMs = cfg.cooldownMs ?? 30_000;
    this.requestTimeoutMs = cfg.requestTimeoutMs ?? 5_000;
  }

  /**
   * Snapshot of the current breaker state. The returned `state` reflects the
   * promotion (open → half_open on cooldown expiry) — see `tickState` for the
   * explicit time-advance mutation this triggers.
   */
  snapshot(): AnchorHealthSnapshot {
    this.tickState();
    return {
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      lastCheckedAt: this.lastCheckedAt,
      lastSuccessAt: this.lastSuccessAt,
      lastError: this.lastError,
      url: this.url,
      probes: { ...this.probes },
    };
  }

  /**
   * `true` when cash-out traffic is allowed. `closed` and `half_open` are both
   * "try it"; only `open` (within the cooldown window) blocks traffic. This
   * method mutates the stored state on cooldown expiry so callers always see
   * the most recent decision; the side-effect is explicit in `tickState`.
   */
  isAvailable(): boolean {
    this.tickState();
    return this.state !== "open";
  }

  /**
   * Time-based advance of the breaker. Promotes `open → half_open` once the
   * cooldown has elapsed, so the next probe becomes a "trial shot". Exposed as
   * a public helper so callers can be explicit about the mutation if they
   * want to; we still call it from getters in this file because that's the
   * sanest policy for snap/decide ergonomics.
   */
  tickState(): void {
    if (
      this.state === "open" &&
      this.openedAt !== null &&
      Date.now() - this.openedAt >= this.cooldownMs
    ) {
      this.state = "half_open";
    }
  }

  /** Run one probe cycle: TOML → SEP-10 challenge → /info. */
  async probe(): Promise<AnchorHealthSnapshot> {
    if (!this.enabled || !this.url || !this.homeDomain) {
      // Mock mode or unconfigured: short-circuit to a healthy state without IO.
      this.tickState();
      this.recordSuccess();
      return this.snapshot();
    }
    // Time-advance before we measure: if the cooldown just elapsed, we want
    // this probe to count as the half-open trial shot rather than get blocked
    // by an out-of-date "open" state.
    this.tickState();
    this.lastCheckedAt = Date.now();
    const probes = { toml: false, sep10: false, info: false };
    try {
      // 1. TOML reachable.
      const tomlUrl = `https://${this.homeDomain}/.well-known/stellar.toml`;
      const tomlRes = await fetchWithTimeout(tomlUrl, this.requestTimeoutMs);
      probes.toml = tomlRes.ok;
      if (!tomlRes.ok) throw new Error(`TOML probe returned ${tomlRes.status}`);

      // 2. SEP-10 challenge obtainable (no signing — this is a liveness check).
      const sep10Url = new URL("/auth", this.url);
      sep10Url.searchParams.set("account", "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAK5KQ");
      sep10Url.searchParams.set("home_domain", this.homeDomain);
      const sep10Res = await fetchWithTimeout(sep10Url.toString(), this.requestTimeoutMs);
      probes.sep10 = sep10Res.ok;
      if (!sep10Res.ok) throw new Error(`SEP-10 challenge returned ${sep10Res.status}`);
      const sep10Body = (await sep10Res.json()) as { transaction?: string };
      if (!sep10Body.transaction) throw new Error("SEP-10 challenge missing transaction");

      // 3. /info 200.
      const infoUrl = new URL("/info", this.url);
      const infoRes = await fetchWithTimeout(infoUrl.toString(), this.requestTimeoutMs);
      probes.info = infoRes.ok;
      if (!infoRes.ok) throw new Error(`/info returned ${infoRes.status}`);

      this.probes = probes;
      this.recordSuccess();
    } catch (err) {
      this.probes = probes;
      this.recordFailure(err);
    }
    return this.snapshot();
  }

  private recordSuccess(): void {
    this.state = "closed";
    this.consecutiveFailures = 0;
    this.openedAt = null;
    this.lastSuccessAt = Date.now();
    this.lastError = null;
  }

  private recordFailure(err: unknown): void {
    this.consecutiveFailures++;
    this.lastError = err instanceof Error ? err.message : String(err);
    if (this.state === "half_open" || this.consecutiveFailures >= this.failureThreshold) {
      this.state = "open";
      this.openedAt = Date.now();
    }
  }
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  return fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
}

export class LinkService {
  private readonly sender: WebhookSender;
  private readonly health: AnchorHealth;
  /** Per-link last poll error (in-memory; survives only until restart). */
  private readonly lastPollErrorByLinkId = new Map<string, string>();
  /**
   * Per-link next-attempt-allowed timestamp. After a status() failure we
   * exponentially back off per job so a downed anchor isn't hammered by the
   * every-interval loop hitting the same failing job id over and over.
   * In-memory only — a follow-up PR adds `next_try_at` to the schema so this
   * survives restart.
   */
  private readonly nextPollAtByLinkId = new Map<string, number>();
  private static readonly POLL_BACKOFF_BASE_MS = 2_000;
  private static readonly POLL_BACKOFF_CAP_MS = 60_000;
  private readonly consecutivePollErrorsByLinkId = new Map<string, number>();

  constructor(
    private readonly deps: {
      links: LinkRepository;
      sellers: SellerRepository;
      webhooks: WebhookRepository;
      rail: RailPort;
      offramp: OffRampPort;
      stellar: StellarConfig;
      /**
       * Optional anchor health probe. When omitted we default to a no-op
       * "always available" probe so existing test fixtures stay lightweight.
       */
      health?: AnchorHealth;
    },
  ) {
    this.sender = new WebhookSender(deps.webhooks);
    this.health =
      deps.health ?? new AnchorHealth({ enabled: false, url: null, homeDomain: null });
  }

  private buildRequest(link: PaymentLink): PaymentRequest {
    return this.deps.rail.buildRequest({
      destination: link.destination,
      amount: link.amount,
      asset: link.asset,
      reference: link.reference,
      message: link.title,
    });
  }

  async createLink(body: CreateLinkBody): Promise<LinkWithRequest> {
    const seller = await this.deps.sellers.getDefault();
    const asset = resolveAsset(body.assetCode, this.deps.stellar);
    const expiresAt = body.expiresInMinutes
      ? Date.now() + body.expiresInMinutes * 60_000
      : null;

    const link = await this.deps.links.create({
      id: newId("lnk"),
      reference: newReference(),
      sellerId: seller.id,
      destination: seller.wallet,
      title: body.title,
      amount: normalizeAmount(body.amount),
      asset,
      expiresAt,
    });

    return { link, request: this.buildRequest(link) };
  }

  async listLinks(): Promise<PaymentLink[]> {
    const seller = await this.deps.sellers.getDefault();
    return this.deps.links.listBySeller(seller.id);
  }

  async getLink(id: string): Promise<LinkWithRequest | null> {
    const link = await this.deps.links.findById(id);
    if (!link) return null;
    return { link, request: this.buildRequest(link) };
  }

  /**
   * Apply a matched payment to its link. Returns whether the link advanced to
   * `paid` (so the worker can decide what to log). Idempotency of the *payment*
   * (processed-tx ledger) is the caller's responsibility; here we additionally
   * guard the domain transition so a duplicate can never double-apply.
   */
  async applyMatch(payment: NormalizedPayment, outcome: MatchOutcome): Promise<boolean> {
    if (outcome.kind === "paid") {
      const link = outcome.link;
      if (!canTransition(link.status, "paid")) return false; // already settled/terminal
      link.status = "paid";
      link.txHash = payment.txHash;
      link.payer = payment.from;
      link.paidAmount = normalizeAmount(payment.amount);
      await this.deps.links.save(link);
      await this.fireWebhook(link, "link.paid", { overpaid: outcome.overpaid });
      return true;
    }

    if (outcome.kind === "underpaid") {
      const link = outcome.link;
      if (!canTransition(link.status, "underpaid")) return false;
      link.status = "underpaid";
      link.txHash = payment.txHash;
      link.payer = payment.from;
      link.paidAmount = normalizeAmount(payment.amount);
      await this.deps.links.save(link);
      await this.fireWebhook(link, "link.underpaid", {});
      return false;
    }

    return false; // no_memo / unknown_reference / asset_mismatch — nothing to apply
  }

  /** Seller-initiated cash-out: quote -> initiate -> move link to offramp_pending. */
  async triggerCashOut(linkId: string, body: CashOutBody): Promise<OffRampJob> {
    const link = await this.deps.links.findById(linkId);
    if (!link) throw new HttpError(404, "Link not found");
    if (link.status !== "paid") {
      throw new HttpError(409, `Link must be paid to cash out (is "${link.status}")`);
    }

    // Fail fast when the breaker is open: never attempt to call a known-dead
    // anchor. The HTTP layer maps this to 503 anchor_unavailable.
    if (!this.health.isAvailable()) {
      throw new HttpError(503, "anchor_unavailable");
    }

    const sourceAmount = link.paidAmount ?? link.amount;
    let quote: OffRampQuote;
    let job: OffRampJob;
    try {
      quote = await this.deps.offramp.quote({
        sourceAsset: link.asset,
        sourceAmount,
        targetCurrency: body.targetCurrency,
      });
      job = await this.deps.offramp.initiate({
        linkId: link.id,
        quoteId: quote.quoteId,
        payout: { currency: body.targetCurrency, fields: body.payoutFields },
      });
    } catch (err) {
      if (err instanceof HttpError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      throw new HttpError(502, `Off-ramp error: ${message}`);
    }

    link.status = "offramp_pending";
    link.offrampJobId = job.jobId;
    link.offrampTargetCurrency = job.targetCurrency;
    link.offrampStatus = "pending";
    await this.deps.links.save(link);
    return job;
  }

  /** Advance any pending cash-outs by polling the off-ramp adapter. */
  async pollCashOuts(): Promise<void> {
    const pending = await this.deps.links.listByStatus("offramp_pending");
    const now = Date.now();
    for (const link of pending) {
      if (!link.offrampJobId) continue;
      // Per-job backoff: while the anchor is sick we don't re-ping it on every
      // tick. Skip links whose `next_try_at` is still in the future.
      const next = this.nextPollAtByLinkId.get(link.id);
      if (next !== undefined && now < next) continue;

      let job: OffRampJob;
      try {
        job = await this.deps.offramp.status(link.offrampJobId);
        // Successful poll clears any prior in-memory last_error + backoff.
        this.lastPollErrorByLinkId.delete(link.id);
        this.consecutivePollErrorsByLinkId.delete(link.id);
        this.nextPollAtByLinkId.delete(link.id);
      } catch (err) {
        // ATTRIBUTABLE: record the error against the link id so it can be
        // exposed in a follow-up PR (and is logged now). Without this catch
        // the swallowed error meant a downed anchor's failures evaporated.
        const message = err instanceof Error ? err.message : String(err);
        this.lastPollErrorByLinkId.set(link.id, message);
        console.warn(`[offramp] poll failed for link ${link.id}: ${message}`);
        // Exponential backoff per job (in-memory). Capped so a long-lived
        // pending job doesn't end up wedged for hours.
        const prev = this.consecutivePollErrorsByLinkId.get(link.id) ?? 0;
        const next1 = Math.min(LinkService.POLL_BACKOFF_CAP_MS, LinkService.POLL_BACKOFF_BASE_MS * 2 ** prev);
        this.consecutivePollErrorsByLinkId.set(link.id, prev + 1);
        this.nextPollAtByLinkId.set(link.id, Date.now() + next1);
        continue;
      }
      if (job.status === "settled") {
        link.status = "offramp_settled";
        link.offrampStatus = "settled";
        await this.deps.links.save(link);
        await this.fireWebhook(link, "offramp.settled", {
          targetCurrency: job.targetCurrency,
          targetAmount: job.targetAmount,
        });
      } else if (job.status === "failed") {
        link.status = "offramp_failed";
        link.offrampStatus = "failed";
        await this.deps.links.save(link);
        await this.fireWebhook(link, "offramp.failed", { reason: job.reason });
      }
    }
  }

  /**
   * Read the in-memory last poll error for a single link, if any. Surface this
   * in a follow-up PR; for now it's the attribution trail the issue asked for.
   */
  lastPollErrorFor(linkId: string): string | null {
    return this.lastPollErrorByLinkId.get(linkId) ?? null;
  }

  /**
   * Snapshot of the anchor health probe + circuit breaker, surfaced by the
   * `/health` endpoint so a downed anchor is observable from operators (and
   * from the seller-facing dashboard in a follow-up).
   */
  healthSnapshot(): AnchorHealthSnapshot {
    return this.health.snapshot();
  }

  private async fireWebhook(
    link: PaymentLink,
    event: string,
    extra: Record<string, unknown>,
  ): Promise<void> {
    const hooks = await this.deps.webhooks.listBySeller(link.sellerId);
    if (hooks.length === 0) return;
    await this.sender.dispatch(hooks, link.id, {
      event,
      data: {
        linkId: link.id,
        reference: link.reference,
        status: link.status,
        amount: link.amount,
        paidAmount: link.paidAmount,
        asset: link.asset,
        txHash: link.txHash,
        ...extra,
      },
    });
  }
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
