import type {
  CreateLinkInput,
  KycPort,
  KycRecord,
  LinkRepository,
  OffRampJob,
  OffRampMode,
  OffRampPort,
  OffRampQuote,
  OffRampStateRepository,
  PaymentLink,
  StoredOffRampJob,
  StoredOffRampQuote,
  Webhook,
  WebhookDelivery,
  WebhookRepository,
} from "@checkout/core";

const DEST = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
const ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

export function makeLink(over: Partial<PaymentLink> = {}): PaymentLink {
  return {
    id: "lnk_1",
    reference: "pl_ref1",
    sellerId: "sel_1",
    destination: DEST,
    muxedId: null,
    title: "Test",
    amount: "10",
    asset: { code: "USDC", issuer: ISSUER },
    status: "paid",
    txHash: "tx1",
    payer: "GBUYER",
    paidAmount: "10",
    offrampJobId: null,
    offrampTargetCurrency: null,
    offrampStatus: null,
    expiresAt: null,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

/** In-memory LinkRepository, seeded from a fixed list of links. */
export class FakeLinkRepository implements LinkRepository {
  private readonly byId = new Map<string, PaymentLink>();

  constructor(seed: PaymentLink[] = []) {
    for (const l of seed) this.byId.set(l.id, l);
  }

  async create(input: CreateLinkInput): Promise<PaymentLink> {
    const link: PaymentLink = {
      ...input,
      status: "active",
      txHash: null,
      payer: null,
      paidAmount: null,
      offrampJobId: null,
      offrampTargetCurrency: null,
      offrampStatus: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.byId.set(link.id, link);
    return link;
  }

  async findById(id: string): Promise<PaymentLink | null> {
    return this.byId.get(id) ?? null;
  }

  async findByReference(reference: string): Promise<PaymentLink | null> {
    return [...this.byId.values()].find((l) => l.reference === reference) ?? null;
  }

  async listBySeller(sellerId: string): Promise<PaymentLink[]> {
    return [...this.byId.values()].filter((l) => l.sellerId === sellerId);
  }

  async listByStatus(status: PaymentLink["status"]): Promise<PaymentLink[]> {
    return [...this.byId.values()].filter((l) => l.status === status);
  }

  async activeDestinations(): Promise<string[]> {
    return [...new Set([...this.byId.values()].map((l) => l.destination))];
  }

  async openLinksForDestination(destination: string): Promise<PaymentLink[]> {
    return [...this.byId.values()].filter(
      (l) => l.destination === destination && (l.status === "active" || l.status === "underpaid"),
    );
  }

  async save(link: PaymentLink): Promise<void> {
    this.byId.set(link.id, { ...link });
  }

  get(id: string): PaymentLink | undefined {
    return this.byId.get(id);
  }
}

export class FakeWebhookRepository implements WebhookRepository {
  readonly deliveries: WebhookDelivery[] = [];
  private readonly hooks: Webhook[] = [];

  async create(input: { sellerId: string; url: string; secret: string }): Promise<Webhook> {
    const hook: Webhook = { id: `whk_${this.hooks.length}`, ...input, createdAt: Date.now() };
    this.hooks.push(hook);
    return hook;
  }

  async listBySeller(sellerId: string): Promise<Webhook[]> {
    return this.hooks.filter((h) => h.sellerId === sellerId);
  }

  async recordDelivery(d: WebhookDelivery): Promise<void> {
    this.deliveries.push(d);
  }
}

/** In-memory OffRampStateRepository — same shape as the Drizzle one, no DB. */
export class FakeOffRampStateRepository implements OffRampStateRepository {
  private readonly quotes = new Map<string, StoredOffRampQuote>();
  private readonly jobs = new Map<string, StoredOffRampJob>();

  async saveQuote(quote: StoredOffRampQuote): Promise<void> {
    this.quotes.set(quote.quoteId, quote);
  }

  async getQuote(quoteId: string): Promise<StoredOffRampQuote | null> {
    return this.quotes.get(quoteId) ?? null;
  }

  async saveJob(job: StoredOffRampJob): Promise<void> {
    this.jobs.set(job.jobId, job);
  }

  async getJob(jobId: string): Promise<StoredOffRampJob | null> {
    return this.jobs.get(jobId) ?? null;
  }

  async updateJob(
    jobId: string,
    patch: Partial<Pick<StoredOffRampJob, "targetAmount" | "status" | "externalStatus" | "lastError">>,
  ): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) return;
    this.jobs.set(jobId, { ...job, ...patch, updatedAt: Date.now() });
  }
}

/** Fully scripted OffRampPort: each method call is driven by a queued/fixed handler. */
export class ScriptedOffRamp implements OffRampPort {
  readonly mode: OffRampMode = "seller_initiated";
  statusImpl: (jobId: string) => Promise<OffRampJob> = () => {
    throw new Error("statusImpl not configured");
  };

  async quote(): Promise<OffRampQuote> {
    throw new Error("not used in these tests");
  }
  async initiate(): Promise<OffRampJob> {
    throw new Error("not used in these tests");
  }
  async status(jobId: string): Promise<OffRampJob> {
    return this.statusImpl(jobId);
  }
}

/** KYC gate that's always ACCEPTED — mirrors `NoKycRequired`, used by tests
 *  that aren't exercising the KYC gate itself. */
export class AlwaysAcceptedKyc implements KycPort {
  async status(sellerId: string): Promise<KycRecord> {
    return this.accepted(sellerId);
  }
  async submit(sellerId: string): Promise<KycRecord> {
    return this.accepted(sellerId);
  }
  private accepted(sellerId: string): KycRecord {
    return {
      sellerId,
      customerId: null,
      status: "ACCEPTED",
      requiredFields: [],
      providedFields: {},
      message: null,
      lastSyncedAt: null,
      updatedAt: Date.now(),
    };
  }
}

/** Fully scripted KycPort for testing the cash-out gate itself. */
export class ScriptedKyc implements KycPort {
  statusImpl: (sellerId: string) => Promise<KycRecord> = () => {
    throw new Error("statusImpl not configured");
  };
  async status(sellerId: string): Promise<KycRecord> {
    return this.statusImpl(sellerId);
  }
  async submit(sellerId: string): Promise<KycRecord> {
    return this.statusImpl(sellerId);
  }
}
