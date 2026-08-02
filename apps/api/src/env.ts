import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Minimal dependency-free .env loader. Walks up from this file and the cwd,
// loading the first .env it finds without overwriting already-set vars.
function loadEnvFiles(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(process.cwd(), ".env"),
    resolve(process.cwd(), "../../.env"),
    resolve(here, "../../../.env"),
    resolve(here, "../../../../.env"),
  ];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    const text = readFileSync(path, "utf8");
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = value;
    }
    break;
  }
}

loadEnvFiles();

function req(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === "") throw new Error(`Missing required env var: ${name}`);
  return v;
}

export type StellarNetwork = "testnet" | "public";

const network = (process.env.STELLAR_NETWORK ?? "testnet") as StellarNetwork;
if (network !== "testnet" && network !== "public") {
  throw new Error(`STELLAR_NETWORK must be "testnet" or "public", got "${network}"`);
}

const watchMode = (process.env.WATCH_MODE ?? "poll") as "poll" | "stream";
if (watchMode !== "poll" && watchMode !== "stream") {
  throw new Error(`WATCH_MODE must be "poll" or "stream", got "${watchMode}"`);
}

// "memo" (default): correlation via MEMO_TEXT. "muxed": SEP-23 M-address, no
// memo needed — survives wallets that drop/mangle memos. Some older wallets
// refuse M... destinations, so this stays opt-in until measured in practice.
const correlation = (process.env.CORRELATION ?? "memo") as "memo" | "muxed";
if (correlation !== "memo" && correlation !== "muxed") {
  throw new Error(`CORRELATION must be "memo" or "muxed", got "${correlation}"`);
}

// "mock" (default, offline-safe) or "testanchor" (real SEP-10/12/38/6 flow
// against https://testanchor.stellar.org). See packages/offramp/src/testanchor.ts.
const offramp = (process.env.OFFRAMP ?? "mock") as "mock" | "testanchor";
if (offramp !== "mock" && offramp !== "testanchor") {
  throw new Error(`OFFRAMP must be "mock" or "testanchor", got "${offramp}"`);
}

export const env = {
  network,
  horizonUrl: process.env.HORIZON_URL || undefined,
  // Optional standby Horizon endpoint. The watcher switches to it after
  // several consecutive failures on the primary, and back on recovery.
  horizonUrlFallback: process.env.HORIZON_URL_FALLBACK || undefined,
  // Consecutive Horizon failures (after retries) before /health reports
  // degraded and (if HORIZON_URL_FALLBACK is set) the watcher switches to it.
  horizonDegradedThreshold: Number(process.env.HORIZON_DEGRADED_THRESHOLD ?? "3"),
  usdcIssuer:
    network === "public"
      ? req("USDC_ISSUER_PUBLIC")
      : req("USDC_ISSUER_TESTNET", "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"),
  databaseUrl: process.env.DATABASE_URL || "file:./local.db",
  // Turso auth token. Unused for local file: URLs.
  databaseAuthToken: process.env.DATABASE_AUTH_TOKEN || undefined,
  apiPort: Number(process.env.API_PORT ?? "8787"),
  pollMs: Number(process.env.WATCH_POLL_MS ?? "6000"),
  // "poll" (default, restart-safe MVP behavior) or "stream" (Horizon SSE,
  // opt-in until proven). See packages/stellar/src/streaming-horizon-watcher.ts.
  watchMode,
  correlation,
  corsOrigins: (process.env.CORS_ORIGINS ?? "http://localhost:3000")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  // Fixed-window rate limit per client IP. Set RATE_LIMIT_MAX=0 to disable.
  rateLimitWindowMs: Number(process.env.RATE_LIMIT_WINDOW_MS ?? "60000"),
  rateLimitMax: Number(process.env.RATE_LIMIT_MAX ?? "120"),
  // Tighter buckets for expensive routes (link creation, cash-out).
  rateLimitStrictWindowMs: Number(process.env.RATE_LIMIT_STRICT_WINDOW_MS ?? "60000"),
  rateLimitStrictMax: Number(process.env.RATE_LIMIT_STRICT_MAX ?? "20"),
  // Number of trusted reverse-proxy hops in front of this instance. Determines
  // which x-forwarded-for entry (from the right) is treated as the real client IP.
  // Default 1 in production (Render's own edge proxy), 0 locally where nothing
  // sits in front of the API and the header (if present at all) is untrusted.
  trustProxyHops: Number(process.env.TRUST_PROXY_HOPS ?? (network === "public" ? "1" : "0")),
  // When set, rate-limit counters are shared across instances via Redis instead
  // of an in-process Map.
  redisUrl: process.env.REDIS_URL || undefined,
  // Seller wallet that receives funds. If unset on testnet, the app generates a
  // throwaway keypair on first boot and prints it. Required on public network.
  defaultSellerWallet: process.env.DEFAULT_SELLER_WALLET || undefined,
  defaultSellerName: process.env.DEFAULT_SELLER_NAME || "Demo Seller",
  offramp,
  // Required only when OFFRAMP=testanchor and DEFAULT_SELLER_WALLET is set (SEP-10
  // needs the seller's secret key to sign the auth challenge). Never persisted.
  defaultSellerSecret: process.env.DEFAULT_SELLER_SECRET || undefined,
  // Bearer token required to read GET /metrics. Auto-generates an ephemeral one
  // (printed once at boot) if unset — the endpoint is always gated.
  metricsToken: process.env.METRICS_TOKEN || undefined,
  // Domain we identify as in SEP-10 challenges + stellar.toml. Should match where
  // this API is actually reachable in production.
  homeDomain: process.env.HOME_DOMAIN || `localhost:${Number(process.env.API_PORT ?? "8787")}`,
  webAuthDomain: process.env.WEB_AUTH_DOMAIN || process.env.HOME_DOMAIN || `localhost:${Number(process.env.API_PORT ?? "8787")}`,
  // Secret key for the identity that SIGNS SEP-10 challenges (our server, not any
  // seller). Auto-generates a throwaway testnet keypair if unset. Required on
  // public network — a login server's signing key must be stable across restarts.
  serverSigningSecret: process.env.SERVER_SIGNING_SECRET || undefined,
  // Symmetric secret for session JWTs minted after a SEP-10 login. Auto-generates
  // an ephemeral one on testnet if unset (sessions won't survive a restart);
  // required on public network.
  jwtSecret: process.env.JWT_SECRET || undefined,
  // Whether the session cookie gets the `Secure` attribute (only sent over
  // HTTPS). Defaults on; set COOKIE_SECURE=false for plain-http local dev,
  // where a Secure cookie would otherwise silently never be sent at all.
  cookieSecure: (process.env.COOKIE_SECURE ?? "true") !== "false",
  // Watcher concurrency and fairness settings
  watcherConcurrency: Number(process.env.WATCHER_CONCURRENCY ?? "10"),
  watcherMaxAccountsPerTick: Number(process.env.WATCHER_MAX_ACCOUNTS_PER_TICK ?? "50"),
  watcherCircuitBreakerThreshold: Number(process.env.WATCHER_CIRCUIT_BREAKER_THRESHOLD ?? "5"),
  watcherCircuitBreakerCooldownMs: Number(process.env.WATCHER_CIRCUIT_BREAKER_COOLDOWN_MS ?? "60000"),
  watcherIdleBackoffTicks: Number(process.env.WATCHER_IDLE_BACKOFF_TICKS ?? "10"),
  watcherAggressivePollTicks: Number(process.env.WATCHER_AGGRESSIVE_POLL_TICKS ?? "5"),
  shutdownTimeoutMs: Number(process.env.SHUTDOWN_TIMEOUT_MS ?? "5000"),
  // AES-256-GCM key (32 bytes, hex) for seller KYC field values at rest.
  // Required only when OFFRAMP=testanchor — mock mode never stores real PII.
  // Generate with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  kycEncryptionKey: offramp === "testanchor" ? req("KYC_ENCRYPTION_KEY") : undefined,
} as const;
