import { randomBytes } from "node:crypto";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import {
  resolveStellarConfig,
  StellarRail,
  HorizonWatcher,
  StreamingHorizonWatcher,
  type HorizonStatus,
} from "@checkout/stellar";
import { MockAnchorOffRamp, NoKycRequired, TestAnchorKyc, TestAnchorOffRamp } from "@checkout/offramp";
import type { KycPort, OffRampPort, OffRampStateRepository } from "@checkout/core";
import { env } from "../env";
import { createDb, bootstrap, type DB } from "../db/client";
import { parsePiiKey } from "../crypto/pii";
import {
  DrizzleLinkRepository,
  DrizzleSellerRepository,
  DrizzleWebhookRepository,
  DrizzleWatcherStateRepository,
  DrizzleTokenRevocationRepository,
  DrizzleOffRampStateRepository,
  DrizzleKycRepository,
} from "../repos/index";
import { LinkService, AnchorHealth } from "./link-service";
import {
  WatcherLoop,
  startCashOutPoller,
  startAnchorProbeTimer,
  type AccountCircuitBreakerStatus,
  type WatcherMetrics,
} from "../worker/watcher-loop";
import { ChallengeService } from "./challenge";
import { horizonSignerFetcher } from "./horizon-signers";
import { SessionIssuer } from "./session";
import type { StellarTomlConfig } from "../routes/well-known";
import { CircuitBreakerOffRamp } from "./circuit-breaker";

export interface Container {
  service: LinkService;
  links: DrizzleLinkRepository;
  sellers: DrizzleSellerRepository;
  webhooks: DrizzleWebhookRepository;
  db: DB;
  kyc: KycPort;
  config: { network: string; horizonUrl: string; sellerWallet: string };
  horizonStatus(): HorizonStatus;
  metricsToken: string;
  watcherLagSeconds(): number;
  circuitBreakerState(): number;
  auth: {
    challenge: ChallengeService;
    session: SessionIssuer;
    stellarToml: StellarTomlConfig;
    revocations: DrizzleTokenRevocationRepository;
    secureCookie: boolean;
  };
  start(): void;
  stop(): void;
  getWatcherCircuitBreakerStatus(): AccountCircuitBreakerStatus[];
  getWatcherMetrics(): WatcherMetrics;
}

export async function createContainer(): Promise<Container> {
  const stellar = resolveStellarConfig({
    network: env.network,
    horizonUrl: env.horizonUrl,
    usdcIssuer: env.usdcIssuer,
  });

  const { db, client } = createDb(env.databaseUrl, env.databaseAuthToken);
  await bootstrap(client);

  const linksRepo = new DrizzleLinkRepository(db);
  const sellersRepo = new DrizzleSellerRepository(db);
  const webhooksRepo = new DrizzleWebhookRepository(db);
  const stateRepo = new DrizzleWatcherStateRepository(db);
  const revocationsRepo = new DrizzleTokenRevocationRepository(db);
  const offrampStateRepo = new DrizzleOffRampStateRepository(db);

  const seller = resolveSellerKeypairOrWallet();
  const sellerWallet = seller.publicKey;
  await sellersRepo.ensureDefault(sellerWallet, env.defaultSellerName);

  const rail = new StellarRail(stellar);
  // Polling watcher gets the retry / fallback / degraded-tracking wrapper
  // (issue #10). The streaming path has its own reconnect handling.
  const pollingWatcher = new HorizonWatcher({
    primaryServer: stellar.horizonUrl,
    fallbackServer: env.horizonUrlFallback,
    degradedThreshold: env.horizonDegradedThreshold,
    log: (m) => console.log(`[horizon] ${m}`),
  });
  const watcher =
    env.watchMode === "stream"
      ? new StreamingHorizonWatcher(stellar.horizonUrl, { log: (m) => console.log(`[watcher:stream] ${m}`) })
      : pollingWatcher;
  const offramp = new CircuitBreakerOffRamp(createOffRamp(seller.keypair, offrampStateRepo));
  const kyc = createKyc(seller.keypair, db);

  // Anchor health probe + circuit breaker (issue #19, 3.7). In mock mode the
  // probe is disabled and short-circuits to "always available" so the dev
  // surface still works offline; in testanchor mode we hit the real anchor.
  const anchorHealth = buildAnchorHealth(env.offramp);

  const service = new LinkService({
    links: linksRepo,
    sellers: sellersRepo,
    webhooks: webhooksRepo,
    rail,
    offramp,
    offrampState: offrampStateRepo,
    kyc,
    stellar,
    health: anchorHealth,
    correlation: env.correlation,
  });

  // A link stuck in `offramp_pending` whose job has no row in offramp_jobs was
  // orphaned by a restart before this state was persisted (or, going forward,
  // a genuinely lost job). Recoverable state doesn't exist for it — fail it out
  // so the seller isn't stuck in silent limbo.
  const backfilled = await service.backfillLostOffRampJobs();
  if (backfilled > 0) {
    console.log(`[offramp] backfilled ${backfilled} link(s) stuck with lost job state -> offramp_failed`);
  }

  const loop = new WatcherLoop({
    watcher,
    links: linksRepo,
    state: stateRepo,
    service,
    pollMs: env.pollMs,
    log: (m) => console.log(`[watcher] ${m}`),
  });

  const metricsToken = resolveMetricsToken();
  const serverKeypair = resolveServerSigningKeypair();
  const challenge = new ChallengeService({
    serverKeypair,
    homeDomain: env.homeDomain,
    webAuthDomain: env.webAuthDomain,
    networkPassphrase: stellar.networkPassphrase,
    fetchAccountSigners: horizonSignerFetcher(stellar.horizonUrl),
  });
  const session = new SessionIssuer(resolveJwtSecret());
  const stellarToml: StellarTomlConfig = {
    signingKey: serverKeypair.publicKey(),
    webAuthEndpoint: `https://${env.webAuthDomain}/auth`,
    networkPassphrase: stellar.networkPassphrase,
    orgName: env.defaultSellerName,
  };

  let stopPoller: (() => void) | null = null;
  let stopRevocationSweep: (() => void) | null = null;
  let stopProbe: (() => void) | null = null;

  return {
    service,
    links: linksRepo,
    sellers: sellersRepo,
    webhooks: webhooksRepo,
    db,
    kyc,
    config: { network: stellar.network, horizonUrl: stellar.horizonUrl, sellerWallet },
    horizonStatus: () => pollingWatcher.getStatus(),
    metricsToken,
    watcherLagSeconds: () => loop.getLagSeconds(),
    circuitBreakerState: () => offramp.getStateNumeric(),
    auth: { challenge, session, stellarToml, revocations: revocationsRepo, secureCookie: env.cookieSecure },
    start() {
      loop.start();
      stopPoller = startCashOutPoller(service, Math.max(3000, env.pollMs));
      stopProbe = startAnchorProbeTimer(anchorHealth, 60_000);
      const sweepTimer = setInterval(
        () => void revocationsRepo.sweepExpired(Math.floor(Date.now() / 1000)),
        60 * 60 * 1000, // hourly — revocation rows are cheap and self-limiting (max 24h lifetime) anyway
      );
      stopRevocationSweep = () => clearInterval(sweepTimer);
    },
    async stop() {
      await loop.stop();
      stopPoller?.();
      stopRevocationSweep?.();
      if (watcher instanceof StreamingHorizonWatcher) watcher.stop();
      stopProbe?.();
      stopPoller = null;
      stopProbe = null;
      await client.close();
      console.log("[api] all services stopped");
    },
    getWatcherCircuitBreakerStatus() {
      return loop.getCircuitBreakerStatus();
    },
    getWatcherMetrics() {
      return loop.getMetrics();
    },
  };
}

/**
 * Build an AnchorHealth with sensible defaults anchored at the public Stellar
 * testnet reference sandbox. Caller can override via env (read raw — we keep
 * the surface minimal and don't pollute env.ts which lives outside the
 * scope of issue 3.7).
 */
function buildAnchorHealth(offrampKind: "mock" | "testanchor"): AnchorHealth {
  const enabled = offrampKind === "testanchor";
  const url = enabled ? process.env.ANCHOR_URL ?? "https://testanchor.stellar.org" : null;
  const homeDomain = enabled ? process.env.ANCHOR_HOME_DOMAIN ?? "testanchor.stellar.org" : null;
  const failureThreshold = Number(process.env.ANCHOR_PROBE_FAILURE_THRESHOLD ?? "3");
  const cooldownMs = Number(process.env.ANCHOR_PROBE_COOLDOWN_MS ?? "30000");
  return new AnchorHealth({
    enabled,
    url,
    homeDomain,
    failureThreshold: Number.isFinite(failureThreshold) && failureThreshold > 0 ? failureThreshold : 3,
    cooldownMs: Number.isFinite(cooldownMs) && cooldownMs > 0 ? cooldownMs : 30_000,
  });
}

/**
 * Resolves the seller's public key, plus its Keypair when we actually hold the
 * secret in-memory (auto-generated testnet keypair, or DEFAULT_SELLER_SECRET
 * explicitly supplied). The Keypair is only needed to sign the SEP-10 auth
 * challenge for `OFFRAMP=testanchor` — never persisted beyond this process.
 */
function resolveSellerKeypairOrWallet(): { keypair: Keypair | null; publicKey: string } {
  if (env.defaultSellerWallet) {
    if (!StrKey.isValidEd25519PublicKey(env.defaultSellerWallet)) {
      throw new Error("DEFAULT_SELLER_WALLET is not a valid Stellar G-address");
    }
    if (!env.defaultSellerSecret) {
      return { keypair: null, publicKey: env.defaultSellerWallet };
    }
    const kp = Keypair.fromSecret(env.defaultSellerSecret);
    if (kp.publicKey() !== env.defaultSellerWallet) {
      throw new Error("DEFAULT_SELLER_SECRET does not match DEFAULT_SELLER_WALLET");
    }
    return { keypair: kp, publicKey: kp.publicKey() };
  }
  if (env.network === "public") {
    throw new Error("Set DEFAULT_SELLER_WALLET to your wallet address before running on public network");
  }
  // Testnet convenience: generate a throwaway account and tell the operator how to fund it.
  const kp = Keypair.random();
  const pub = kp.publicKey();
  console.log(
    [
      "",
      "──────────────────────────────────────────────────────────────────",
      " No DEFAULT_SELLER_WALLET set — generated a TESTNET seller keypair.",
      ` Public key (receives funds): ${pub}`,
      ` Secret key (import into a wallet to move funds): ${kp.secret()}`,
      " Fund it: https://friendbot.stellar.org/?addr=" + pub,
      " Set DEFAULT_SELLER_WALLET in .env to reuse a stable address across restarts.",
      "──────────────────────────────────────────────────────────────────",
      "",
    ].join("\n"),
  );
  return { keypair: kp, publicKey: pub };
}

function createOffRamp(sellerKeypair: Keypair | null, state: OffRampStateRepository): OffRampPort {
  if (env.offramp === "mock") {
    // Demo off-ramp: settles 8s after a seller triggers cash-out. NOT a real anchor.
    return new MockAnchorOffRamp({ state, settleAfterMs: 8000 });
  }
  if (!sellerKeypair) {
    throw new Error(
      "OFFRAMP=testanchor requires the seller's secret key to sign SEP-10 auth: " +
        "set DEFAULT_SELLER_SECRET (matching DEFAULT_SELLER_WALLET), or leave " +
        "DEFAULT_SELLER_WALLET unset on testnet to use the auto-generated keypair.",
    );
  }
  return new TestAnchorOffRamp({ sellerKeypair, state });
}

function createKyc(sellerKeypair: Keypair | null, db: DB): KycPort {
  if (env.offramp === "mock") {
    // No real anchor, nothing to be compliant with — never gates the simulated cash-out.
    return new NoKycRequired();
  }
  if (!sellerKeypair) {
    throw new Error(
      "OFFRAMP=testanchor requires the seller's secret key to sign SEP-10 auth: " +
        "set DEFAULT_SELLER_SECRET (matching DEFAULT_SELLER_WALLET), or leave " +
        "DEFAULT_SELLER_WALLET unset on testnet to use the auto-generated keypair.",
    );
  }
  // env.kycEncryptionKey is guaranteed set when OFFRAMP=testanchor (see env.ts).
  const repo = new DrizzleKycRepository(db, parsePiiKey(env.kycEncryptionKey as string));
  return new TestAnchorKyc({ sellerKeypair, repo });
}

/**
 * Resolves the keypair that SIGNS SEP-10 challenges — the platform's own login
 * identity, distinct from any seller's wallet. Required to be stable
 * (SERVER_SIGNING_SECRET) on public network; auto-generates a throwaway testnet
 * keypair otherwise, same convenience as `resolveSellerKeypairOrWallet`.
 */
function resolveServerSigningKeypair(): Keypair {
  if (env.serverSigningSecret) return Keypair.fromSecret(env.serverSigningSecret);
  if (env.network === "public") {
    throw new Error("Set SERVER_SIGNING_SECRET before running on public network (SEP-10 needs a stable signing key)");
  }
  const kp = Keypair.random();
  console.log(
    [
      "",
      "──────────────────────────────────────────────────────────────────",
      " No SERVER_SIGNING_SECRET set — generated a TESTNET SEP-10 signing keypair.",
      ` Signing key (in stellar.toml): ${kp.publicKey()}`,
      " Set SERVER_SIGNING_SECRET in .env to keep this stable across restarts —",
      " every restart otherwise invalidates in-flight sessions and stellar.toml.",
      "──────────────────────────────────────────────────────────────────",
      "",
    ].join("\n"),
  );
  return kp;
}

/** Resolves the JWT session secret. Required on public network; auto-generates
 *  an ephemeral one on testnet (sessions won't survive a restart). */
function resolveJwtSecret(): string {
  if (env.jwtSecret) return env.jwtSecret;
  if (env.network === "public") {
    throw new Error("Set JWT_SECRET before running on public network (needed to mint stable sessions)");
  }
  console.log(" No JWT_SECRET set — generated an ephemeral testnet session secret (won't survive a restart).");
  return randomBytes(32).toString("hex");
}

/** Resolves the bearer token that gates `GET /metrics`. Auto-generates an
 *  ephemeral one (printed once at boot) if METRICS_TOKEN isn't set — the
 *  endpoint is always gated, never open by default. */
function resolveMetricsToken(): string {
  if (env.metricsToken) return env.metricsToken;
  const token = randomBytes(24).toString("hex");
  console.log(` No METRICS_TOKEN set — generated an ephemeral one for /metrics: ${token}`);
  return token;
}
