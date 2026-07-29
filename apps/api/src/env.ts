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

export const env = {
  network,
  horizonUrl: process.env.HORIZON_URL || undefined,
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
  corsOrigins: (process.env.CORS_ORIGINS ?? "http://localhost:3000")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  // Fixed-window rate limit per client IP. Set RATE_LIMIT_MAX=0 to disable.
  rateLimitWindowMs: Number(process.env.RATE_LIMIT_WINDOW_MS ?? "60000"),
  rateLimitMax: Number(process.env.RATE_LIMIT_MAX ?? "120"),
  // Seller wallet that receives funds. If unset on testnet, the app generates a
  // throwaway keypair on first boot and prints it. Required on public network.
  defaultSellerWallet: process.env.DEFAULT_SELLER_WALLET || undefined,
  defaultSellerName: process.env.DEFAULT_SELLER_NAME || "Demo Seller",
  // "mock" (default, offline-safe) or "testanchor" (real SEP-10/38/6 flow against
  // https://testanchor.stellar.org). See packages/offramp/src/testanchor.ts.
  offramp: (process.env.OFFRAMP ?? "mock") as "mock" | "testanchor",
  // Required only when OFFRAMP=testanchor and DEFAULT_SELLER_WALLET is set (SEP-10
  // needs the seller's secret key to sign the auth challenge). Never persisted.
  defaultSellerSecret: process.env.DEFAULT_SELLER_SECRET || undefined,
  // Watcher concurrency and fairness settings
  watcherConcurrency: Number(process.env.WATCHER_CONCURRENCY ?? "10"),
  watcherMaxAccountsPerTick: Number(process.env.WATCHER_MAX_ACCOUNTS_PER_TICK ?? "50"),
  watcherCircuitBreakerThreshold: Number(process.env.WATCHER_CIRCUIT_BREAKER_THRESHOLD ?? "5"),
  watcherCircuitBreakerCooldownMs: Number(process.env.WATCHER_CIRCUIT_BREAKER_COOLDOWN_MS ?? "60000"),
  watcherIdleBackoffTicks: Number(process.env.WATCHER_IDLE_BACKOFF_TICKS ?? "10"),
  watcherAggressivePollTicks: Number(process.env.WATCHER_AGGRESSIVE_POLL_TICKS ?? "5"),
  shutdownTimeoutMs: Number(process.env.SHUTDOWN_TIMEOUT_MS ?? "5000"),
} as const;
