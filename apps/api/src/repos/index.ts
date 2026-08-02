import { eq, and, inArray, lt } from "drizzle-orm";
import type {
  CreateLinkInput,
  KycFieldSpec,
  KycRecord,
  KycRepository,
  KycStatus,
  LinkRepository,
  OffRampStateRepository,
  PaymentLink,
  Seller,
  SellerRepository,
  TokenRevocationRepository,
  StoredOffRampJob,
  StoredOffRampQuote,
  Webhook,
  WebhookDelivery,
  WebhookRepository,
  WatcherStateRepository,
  AssetRef,
} from "@checkout/core";
import type { DB } from "../db/client";
import {
  links,
  sellers,
  webhooks,
  webhookDeliveries,
  watcherCursors,
  processedTx,
  offrampQuotes,
  offrampJobs,
  sellerKyc,
  revokedTokens,
} from "../db/schema";
import { newId } from "../services/ids";
import { decryptPii, encryptPii } from "../crypto/pii";

type LinkRow = typeof links.$inferSelect;

const OPEN_STATUSES = ["active", "underpaid"];

function assetFromRow(row: LinkRow): AssetRef {
  return { code: row.assetCode, issuer: row.assetIssuer ?? null };
}

function rowToLink(row: LinkRow): PaymentLink {
  return {
    id: row.id,
    reference: row.reference,
    sellerId: row.sellerId,
    destination: row.destination,
    muxedId: row.muxedId ?? null,
    title: row.title,
    amount: row.amount,
    asset: assetFromRow(row),
    status: row.status as PaymentLink["status"],
    txHash: row.txHash ?? null,
    payer: row.payer ?? null,
    paidAmount: row.paidAmount ?? null,
    offrampJobId: row.offrampJobId ?? null,
    offrampTargetCurrency: row.offrampTargetCurrency ?? null,
    offrampStatus: row.offrampStatus ?? null,
    expiresAt: row.expiresAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class DrizzleLinkRepository implements LinkRepository {
  constructor(private readonly db: DB) {}

  async create(input: CreateLinkInput): Promise<PaymentLink> {
    const now = Date.now();
    const row: LinkRow = {
      id: input.id,
      reference: input.reference,
      sellerId: input.sellerId,
      destination: input.destination,
      muxedId: input.muxedId,
      title: input.title,
      amount: input.amount,
      assetCode: input.asset.code,
      assetIssuer: input.asset.issuer,
      status: "active",
      txHash: null,
      payer: null,
      paidAmount: null,
      offrampJobId: null,
      offrampTargetCurrency: null,
      offrampStatus: null,
      expiresAt: input.expiresAt,
      createdAt: now,
      updatedAt: now,
    };
    await this.db.insert(links).values(row);
    return rowToLink(row);
  }

  async findById(id: string): Promise<PaymentLink | null> {
    const rows = await this.db.select().from(links).where(eq(links.id, id)).limit(1);
    return rows[0] ? rowToLink(rows[0]) : null;
  }

  async findByReference(reference: string): Promise<PaymentLink | null> {
    const rows = await this.db.select().from(links).where(eq(links.reference, reference)).limit(1);
    return rows[0] ? rowToLink(rows[0]) : null;
  }

  async listBySeller(sellerId: string): Promise<PaymentLink[]> {
    const rows = await this.db.select().from(links).where(eq(links.sellerId, sellerId));
    return rows.map(rowToLink).sort((a, b) => b.createdAt - a.createdAt);
  }

  async listByStatus(status: PaymentLink["status"]): Promise<PaymentLink[]> {
    const rows = await this.db.select().from(links).where(eq(links.status, status));
    return rows.map(rowToLink);
  }

  async activeDestinations(): Promise<string[]> {
    const rows = await this.db
      .select({ destination: links.destination })
      .from(links)
      .where(inArray(links.status, OPEN_STATUSES));
    return [...new Set(rows.map((r) => r.destination))];
  }

  async openLinksForDestination(destination: string): Promise<PaymentLink[]> {
    const rows = await this.db
      .select()
      .from(links)
      .where(and(eq(links.destination, destination), inArray(links.status, OPEN_STATUSES)));
    return rows.map(rowToLink);
  }

  async save(link: PaymentLink): Promise<void> {
    await this.db
      .update(links)
      .set({
        status: link.status,
        txHash: link.txHash,
        payer: link.payer,
        paidAmount: link.paidAmount,
        offrampJobId: link.offrampJobId,
        offrampTargetCurrency: link.offrampTargetCurrency,
        offrampStatus: link.offrampStatus,
        updatedAt: Date.now(),
      })
      .where(eq(links.id, link.id));
  }
}

export class DrizzleSellerRepository implements SellerRepository {
  constructor(private readonly db: DB) {}

  /** Seed (once) and return the single demo seller. */
  async ensureDefault(wallet: string, name: string): Promise<Seller> {
    const existing = await this.db.select().from(sellers).limit(1);
    if (existing[0]) {
      // keep the wallet in sync if it changed in env
      if (existing[0].wallet !== wallet) {
        await this.db.update(sellers).set({ wallet }).where(eq(sellers.id, existing[0].id));
      }
      return { ...existing[0], wallet };
    }
    const seller: Seller = { id: newId("sel"), name, wallet, createdAt: Date.now() };
    await this.db.insert(sellers).values(seller);
    return seller;
  }

  async getDefault(): Promise<Seller> {
    const rows = await this.db.select().from(sellers).limit(1);
    if (!rows[0]) throw new Error("No default seller seeded");
    return rows[0];
  }

  async findById(id: string): Promise<Seller | null> {
    const rows = await this.db.select().from(sellers).where(eq(sellers.id, id)).limit(1);
    return rows[0] ?? null;
  }

  async findByWallet(wallet: string): Promise<Seller | null> {
    const rows = await this.db.select().from(sellers).where(eq(sellers.wallet, wallet)).limit(1);
    return rows[0] ?? null;
  }

  async createIfAbsent(wallet: string): Promise<Seller> {
    await this.db
      .insert(sellers)
      .values({ id: newId("sel"), name: shortWallet(wallet), wallet, createdAt: Date.now() })
      .onConflictDoNothing({ target: sellers.wallet });
    const seller = await this.findByWallet(wallet);
    if (!seller) throw new Error(`failed to create or find seller for wallet ${wallet}`);
    return seller;
  }
}

function shortWallet(wallet: string): string {
  return `${wallet.slice(0, 4)}…${wallet.slice(-4)}`;
}

export class DrizzleWebhookRepository implements WebhookRepository {
  constructor(private readonly db: DB) {}

  async create(input: { sellerId: string; url: string; secret: string }): Promise<Webhook> {
    const hook: Webhook = {
      id: newId("whk"),
      sellerId: input.sellerId,
      url: input.url,
      secret: input.secret,
      createdAt: Date.now(),
    };
    await this.db.insert(webhooks).values(hook);
    return hook;
  }

  async listBySeller(sellerId: string): Promise<Webhook[]> {
    return this.db.select().from(webhooks).where(eq(webhooks.sellerId, sellerId));
  }

  async recordDelivery(d: WebhookDelivery): Promise<void> {
    await this.db.insert(webhookDeliveries).values({
      id: newId("whd"),
      webhookId: d.webhookId,
      linkId: d.linkId,
      event: d.event,
      statusCode: d.statusCode,
      ok: d.ok,
      error: d.error,
      createdAt: Date.now(),
    });
  }
}

export class DrizzleWatcherStateRepository implements WatcherStateRepository {
  constructor(private readonly db: DB) {}

  async getCursor(account: string): Promise<string | null> {
    const rows = await this.db
      .select()
      .from(watcherCursors)
      .where(eq(watcherCursors.account, account))
      .limit(1);
    return rows[0]?.cursor ?? null;
  }

  async setCursor(account: string, cursor: string): Promise<void> {
    await this.db
      .insert(watcherCursors)
      .values({ account, cursor, updatedAt: Date.now() })
      .onConflictDoUpdate({
        target: watcherCursors.account,
        set: { cursor, updatedAt: Date.now() },
      });
  }

  async isProcessed(txHash: string): Promise<boolean> {
    const rows = await this.db
      .select({ txHash: processedTx.txHash })
      .from(processedTx)
      .where(eq(processedTx.txHash, txHash))
      .limit(1);
    return rows.length > 0;
  }

  async markProcessed(txHash: string, linkId: string | null): Promise<void> {
    await this.db
      .insert(processedTx)
      .values({ txHash, linkId, createdAt: Date.now() })
      .onConflictDoNothing();
  }
}

export class DrizzleTokenRevocationRepository implements TokenRevocationRepository {
  constructor(private readonly db: DB) {}

  async revoke(jti: string, expiresAt: number): Promise<void> {
    await this.db
      .insert(revokedTokens)
      .values({ jti, expiresAt, revokedAt: Date.now() })
      .onConflictDoNothing();
  }

  async isRevoked(jti: string): Promise<boolean> {
    const rows = await this.db.select({ jti: revokedTokens.jti }).from(revokedTokens).where(eq(revokedTokens.jti, jti)).limit(1);
    return rows.length > 0;
  }

  async sweepExpired(now: number): Promise<void> {
    await this.db.delete(revokedTokens).where(lt(revokedTokens.expiresAt, now));
  }
}

type OffRampQuoteRow = typeof offrampQuotes.$inferSelect;
type OffRampJobRow = typeof offrampJobs.$inferSelect;

function rowToQuote(row: OffRampQuoteRow): StoredOffRampQuote {
  return {
    quoteId: row.quoteId,
    linkId: row.linkId,
    sellAsset: { code: row.sellAssetCode, issuer: row.sellAssetIssuer ?? null },
    sellAmount: row.sellAmount,
    buyCurrency: row.buyCurrency,
    price: row.price,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
  };
}

function rowToJob(row: OffRampJobRow): StoredOffRampJob {
  return {
    jobId: row.jobId,
    linkId: row.linkId,
    anchor: row.anchor,
    targetCurrency: row.targetCurrency,
    targetAmount: row.targetAmount,
    rate: row.rate,
    status: row.status as StoredOffRampJob["status"],
    externalStatus: row.externalStatus ?? null,
    lastError: row.lastError ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Off-ramp quotes and jobs — money-adjacent state that must survive a restart. */
export class DrizzleOffRampStateRepository implements OffRampStateRepository {
  constructor(private readonly db: DB) {}

  async saveQuote(quote: StoredOffRampQuote): Promise<void> {
    await this.db.insert(offrampQuotes).values({
      quoteId: quote.quoteId,
      linkId: quote.linkId,
      sellAssetCode: quote.sellAsset.code,
      sellAssetIssuer: quote.sellAsset.issuer,
      sellAmount: quote.sellAmount,
      buyCurrency: quote.buyCurrency,
      price: quote.price,
      expiresAt: quote.expiresAt,
      createdAt: quote.createdAt,
    });
  }

  async getQuote(quoteId: string): Promise<StoredOffRampQuote | null> {
    const rows = await this.db.select().from(offrampQuotes).where(eq(offrampQuotes.quoteId, quoteId)).limit(1);
    return rows[0] ? rowToQuote(rows[0]) : null;
  }

  async saveJob(job: StoredOffRampJob): Promise<void> {
    await this.db.insert(offrampJobs).values({
      jobId: job.jobId,
      linkId: job.linkId,
      anchor: job.anchor,
      targetCurrency: job.targetCurrency,
      targetAmount: job.targetAmount,
      rate: job.rate,
      status: job.status,
      externalStatus: job.externalStatus,
      lastError: job.lastError,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    });
  }

  async getJob(jobId: string): Promise<StoredOffRampJob | null> {
    const rows = await this.db.select().from(offrampJobs).where(eq(offrampJobs.jobId, jobId)).limit(1);
    return rows[0] ? rowToJob(rows[0]) : null;
  }

  async updateJob(
    jobId: string,
    patch: Partial<Pick<StoredOffRampJob, "targetAmount" | "status" | "externalStatus" | "lastError">>,
  ): Promise<void> {
    await this.db
      .update(offrampJobs)
      .set({ ...patch, updatedAt: Date.now() })
      .where(eq(offrampJobs.jobId, jobId));
  }
}

type SellerKycRow = typeof sellerKyc.$inferSelect;

/**
 * Seller-level SEP-12 KYC state. `fieldsEncrypted` is the seller's submitted
 * PII (name, email, address, ...) — encrypted with `piiKey` before it ever
 * touches the database, decrypted only in-process when read back.
 */
export class DrizzleKycRepository implements KycRepository {
  constructor(
    private readonly db: DB,
    private readonly piiKey: Buffer,
  ) {}

  private rowToRecord(row: SellerKycRow): KycRecord {
    return {
      sellerId: row.sellerId,
      customerId: row.customerId ?? null,
      status: row.status as KycStatus,
      requiredFields: JSON.parse(row.requiredFields) as KycFieldSpec[],
      providedFields: JSON.parse(decryptPii(row.fieldsEncrypted, this.piiKey)) as Record<string, string>,
      message: row.message ?? null,
      lastSyncedAt: row.lastSyncedAt ?? null,
      updatedAt: row.updatedAt,
    };
  }

  async get(sellerId: string): Promise<KycRecord | null> {
    const rows = await this.db.select().from(sellerKyc).where(eq(sellerKyc.sellerId, sellerId)).limit(1);
    return rows[0] ? this.rowToRecord(rows[0]) : null;
  }

  async save(record: KycRecord): Promise<void> {
    const row = {
      sellerId: record.sellerId,
      customerId: record.customerId,
      status: record.status,
      requiredFields: JSON.stringify(record.requiredFields),
      fieldsEncrypted: encryptPii(JSON.stringify(record.providedFields), this.piiKey),
      message: record.message,
      lastSyncedAt: record.lastSyncedAt,
      updatedAt: record.updatedAt,
    };
    await this.db
      .insert(sellerKyc)
      .values(row)
      .onConflictDoUpdate({ target: sellerKyc.sellerId, set: row });
  }
}
