import { createClient, type Client } from "@libsql/client";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import * as schema from "./schema";

export type DB = LibSQLDatabase<typeof schema>;

// CREATE TABLE IF NOT EXISTS so a fresh clone runs with no migration step.
// (drizzle-kit push can manage this instead; see drizzle.config.ts.)
const BOOTSTRAP_SQL = [
  `CREATE TABLE IF NOT EXISTS sellers (
     id TEXT PRIMARY KEY, name TEXT NOT NULL, wallet TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS links (
     id TEXT PRIMARY KEY, reference TEXT NOT NULL UNIQUE, seller_id TEXT NOT NULL,
     destination TEXT NOT NULL, muxed_id TEXT, title TEXT NOT NULL, amount TEXT NOT NULL,
     asset_code TEXT NOT NULL, asset_issuer TEXT, status TEXT NOT NULL,
     tx_hash TEXT, payer TEXT, paid_amount TEXT,
     offramp_job_id TEXT, offramp_target_currency TEXT, offramp_status TEXT,
     expires_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS webhooks (
     id TEXT PRIMARY KEY, seller_id TEXT NOT NULL, url TEXT NOT NULL,
     secret TEXT NOT NULL, created_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS webhook_deliveries (
     id TEXT PRIMARY KEY, webhook_id TEXT NOT NULL, link_id TEXT NOT NULL,
     event TEXT NOT NULL, status_code INTEGER, ok INTEGER NOT NULL,
     error TEXT, created_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS offramp_quotes (
     quote_id TEXT PRIMARY KEY, link_id TEXT NOT NULL,
     sell_asset_code TEXT NOT NULL, sell_asset_issuer TEXT, sell_amount TEXT NOT NULL,
     buy_currency TEXT NOT NULL, price TEXT NOT NULL,
     expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS offramp_jobs (
     job_id TEXT PRIMARY KEY, link_id TEXT NOT NULL, anchor TEXT NOT NULL,
     target_currency TEXT NOT NULL, target_amount TEXT NOT NULL, rate TEXT NOT NULL,
     status TEXT NOT NULL, external_status TEXT, last_error TEXT,
     created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS seller_kyc (
     seller_id TEXT PRIMARY KEY, customer_id TEXT, status TEXT NOT NULL,
     required_fields TEXT NOT NULL, fields_encrypted TEXT NOT NULL,
     message TEXT, last_synced_at INTEGER, updated_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS watcher_cursors (
     account TEXT PRIMARY KEY, cursor TEXT NOT NULL, updated_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS processed_tx (
     tx_hash TEXT PRIMARY KEY, link_id TEXT, created_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS idempotency_keys (
     key TEXT NOT NULL, seller_id TEXT NOT NULL, endpoint TEXT NOT NULL,
     request_hash TEXT NOT NULL, response_status INTEGER NOT NULL,
     response_body TEXT NOT NULL, created_at INTEGER NOT NULL,
     PRIMARY KEY (key, seller_id)
   )`,
  `CREATE TABLE IF NOT EXISTS revoked_tokens (
     jti TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, revoked_at INTEGER NOT NULL
   )`,
];

export function createDb(databaseUrl: string, authToken?: string): { db: DB; client: Client } {
  const client = createClient({ url: databaseUrl, authToken });
  const db = drizzle(client, { schema });
  return { db, client };
}

// Additive column added after the initial release. `CREATE TABLE IF NOT EXISTS`
// above won't touch an existing table, so add it out-of-band; ignore the
// "duplicate column" error on databases that already have it.
const MIGRATIONS_SQL = [`ALTER TABLE links ADD COLUMN muxed_id TEXT`];

export async function bootstrap(client: Client): Promise<void> {
  for (const sql of BOOTSTRAP_SQL) {
    await client.execute(sql);
  }
  for (const sql of MIGRATIONS_SQL) {
    try {
      await client.execute(sql);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!message.toLowerCase().includes("duplicate column")) throw err;
    }
  }
}

export { schema };
