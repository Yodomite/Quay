import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import * as schema from "../src/db/schema";
import { bootstrap } from "../src/db/client";
import {
  DrizzleLinkRepository,
  DrizzleSellerRepository,
  DrizzleWebhookRepository,
  DrizzleWatcherStateRepository,
  DrizzleOffRampStateRepository,
  DrizzleTokenRevocationRepository,
} from "../src/repos/index";
import { SessionIssuer } from "../src/services/session";
import type { Container } from "../src/services/container";
import { NoKycRequired } from "@checkout/offramp";
import { LinkService } from "../src/services/link-service";
import type {
  AssetRef,
  PaymentRequest,
  RailPort,
  WatcherPort,
  NormalizedPayment,
  OffRampPort,
  OffRampQuote,
  OffRampJob,
} from "@checkout/core";
import type { StellarConfig } from "@checkout/stellar";
import type { DB } from "../src/db/client";

// ---------------------------------------------------------------------------
//  Test DB — in-memory libSQL
// ---------------------------------------------------------------------------

/** Each test gets a freshly bootstrapped in-memory DB. */
export function createTestDb(): { db: DB; client: Client } {
  const client = createClient({ url: "file::memory:" });
  const db = drizzle(client, { schema });
  return { db, client };
}

export async function withTestDb(): Promise<{
  db: DB;
  client: Client;
  links: DrizzleLinkRepository;
  sellers: DrizzleSellerRepository;
  webhooks: DrizzleWebhookRepository;
  state: DrizzleWatcherStateRepository;
}> {
  const { db, client } = createTestDb();
  await bootstrap(client);
  const links = new DrizzleLinkRepository(db);
  const sellers = new DrizzleSellerRepository(db);
  const webhooks = new DrizzleWebhookRepository(db);
  const state = new DrizzleWatcherStateRepository(db);
  await sellers.ensureDefault("GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN", "Test Seller");
  return { db, client, links, sellers, webhooks, state };
}

// ---------------------------------------------------------------------------
//  Fake RailPort
// ---------------------------------------------------------------------------

export class FakeRailPort implements RailPort {
  isValidDestination(_address: string): boolean {
    return true;
  }

  /** Preflight always passes in tests; the trustline path has its own suite. */
  async assertCanReceive(): Promise<void> {}

  buildRequest(input: {
    destination: string;
    amount: string;
    asset: AssetRef;
    reference: string;
    message?: string;
  }): PaymentRequest {
    return {
      uri: `web+stellar:pay?destination=${input.destination}&amount=${input.amount}&asset_code=${input.asset.code}${input.asset.issuer ? `&asset_issuer=${input.asset.issuer}` : ""}&memo=${input.reference}&memo_type=MEMO_TEXT`,
      destination: input.destination,
      amount: input.amount,
      asset: input.asset,
      memo: input.reference,
    };
  }
}

// ---------------------------------------------------------------------------
//  Fake WatcherPort
// ---------------------------------------------------------------------------

export class FakeWatcherPort implements WatcherPort {
  private payments: NormalizedPayment[] = [];

  /** Set the scripted payments this watcher returns on the next fetchSince. */
  setPayments(payments: NormalizedPayment[]): void {
    this.payments = payments;
  }

  /** Clear all pending payments. */
  clearPayments(): void {
    this.payments = [];
  }

  async latestCursor(_account: string): Promise<string | null> {
    return "100";
  }

  async fetchSince(_account: string, _cursor: string, _limit?: number): Promise<NormalizedPayment[]> {
    const result = this.payments;
    this.payments = [];
    return result;
  }

  /** Helper to create a normalized payment for tests. */
  static payment(over: Partial<NormalizedPayment> = {}): NormalizedPayment {
    const seq = Math.random().toString(36).slice(2, 10);
    return {
      txHash: `tx_${seq}`,
      pagingToken: String(++FakeWatcherPort._tokenSeq),
      from: "GBUYER",
      to: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
      amount: "10",
      asset: { code: "USDC", issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5" },
      memo: "ref_test",
      memoType: "text",
      toMuxedId: null,
      createdAt: new Date().toISOString(),
      ...over,
    };
  }

  private static _tokenSeq = 1000;
}

// ---------------------------------------------------------------------------
//  Fake OffRampPort
// ---------------------------------------------------------------------------

export class FakeOffRampPort implements OffRampPort {
  readonly mode = "seller_initiated" as const;

  private nextQuoteId = 1;
  private nextJobId = 1;

  async quote(input: {
    sourceAsset: AssetRef;
    sourceAmount: string;
    targetCurrency: string;
  }): Promise<OffRampQuote> {
    const rate = input.targetCurrency === "NGN" ? 1650 : 1;
    return {
      quoteId: `quote_${this.nextQuoteId++}`,
      sourceAsset: input.sourceAsset,
      sourceAmount: input.sourceAmount,
      targetCurrency: input.targetCurrency,
      targetAmount: (Number(input.sourceAmount) * rate).toFixed(2),
      rate: String(rate),
      expiresAt: Date.now() + 300_000,
    };
  }

  async initiate(input: {
    linkId: string;
    quoteId: string;
    payout: { currency: string; fields: Record<string, string> };
  }): Promise<OffRampJob> {
    return {
      jobId: `job_${this.nextJobId++}`,
      linkId: input.linkId,
      status: "pending",
      targetCurrency: input.payout.currency,
      targetAmount: "1000.00",
      rate: "1650",
    };
  }

  async status(_jobId: string): Promise<OffRampJob> {
    return {
      jobId: "job_1",
      linkId: "lnk_1",
      status: "settled",
      targetCurrency: "NGN",
      targetAmount: "1000.00",
      rate: "1650",
    };
  }
}

// ---------------------------------------------------------------------------
//  Test StellarConfig
// ---------------------------------------------------------------------------

export const testStellarConfig: StellarConfig = {
  network: "testnet",
  horizonUrl: "https://horizon-testnet.stellar.org",
  networkPassphrase: "Test SDF Network ; September 2015",
  usdcIssuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
};

// ---------------------------------------------------------------------------
//  Test Container
// ---------------------------------------------------------------------------

export interface TestContainer extends Container {
  service: LinkService;
  links: DrizzleLinkRepository;
  sellers: DrizzleSellerRepository;
  webhooks: DrizzleWebhookRepository;
  state: DrizzleWatcherStateRepository;
  rail: FakeRailPort;
  watcher: FakeWatcherPort;
  offramp: FakeOffRampPort;
  db: DB;
  client: Client;
  config: { network: string; horizonUrl: string; sellerWallet: string };
  /** Mints a bearer token for a seller, so route tests can authenticate. */
  tokenFor(sellerId: string, wallet: string): Promise<string>;
  start(): void;
  stop(): void;
}

export async function createTestContainer(): Promise<TestContainer> {
  const repos = await withTestDb();

  const rail = new FakeRailPort();
  const watcher = new FakeWatcherPort();
  const offramp = new FakeOffRampPort();

  const offrampState = new DrizzleOffRampStateRepository(repos.db);

  const service = new LinkService({
    links: repos.links,
    sellers: repos.sellers,
    webhooks: repos.webhooks,
    rail,
    offramp,
    offrampState,
    kyc: new NoKycRequired(),
    stellar: testStellarConfig,
    correlation: "memo",
  });

  const session = new SessionIssuer("test-session-secret");
  const revocations = new DrizzleTokenRevocationRepository(repos.db);

  return {
    service,
    links: repos.links,
    sellers: repos.sellers,
    webhooks: repos.webhooks,
    state: repos.state,
    rail,
    watcher,
    offramp,
    db: repos.db,
    client: repos.client,
    kyc: new NoKycRequired() as unknown as Container["kyc"],
    auth: { session, revocations, stellarToml: {}, challenge: {}, secureCookie: false } as unknown as Container["auth"],
    horizonStatus: () => ({ degraded: false, usingFallback: false, consecutiveFailures: 0 }),
    metricsToken: "test-metrics-token",
    watcherLagSeconds: () => 0,
    circuitBreakerState: () => 0,
    getWatcherCircuitBreakerStatus: () => [],
    getWatcherMetrics: () => ({
      accountsWatched: 0,
      tickDurationMs: 0,
      perAccountLag: new Map(),
      circuitBreakersOpen: 0,
    }),
    async tokenFor(sellerId: string, wallet: string) {
      const issued = await session.issue({ sub: wallet, sellerId });
      return issued.token;
    },
    config: {
      network: "testnet",
      horizonUrl: "https://horizon-testnet.stellar.org",
      sellerWallet: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    },
    start() {},
    stop() {},
  };
}


