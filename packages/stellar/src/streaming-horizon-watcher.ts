import type { NormalizedPayment, WatcherPort } from "@checkout/core";
import { normalizePayment } from "./normalize";
import {
  type HorizonClient,
  type HorizonPaymentRecord,
  isNotFound,
  realHorizonClient,
} from "./horizon-client";

const DEFAULT_INITIAL_BACKOFF_MS = 1000;
const DEFAULT_MAX_BACKOFF_MS = 30_000;
const RECONCILE_PAGE_LIMIT = 200;

/** Per-account SSE subscription plus the events it has buffered for `fetchSince`. */
interface AccountStream {
  // Buffered, normalized payments not yet trimmed, keyed by paging token so
  // duplicate deliveries (reconcile poll vs. resumed stream) collapse for free.
  buffer: Map<string, NormalizedPayment>;
  // Highest paging token this stream has ever ingested (poll or SSE), used to
  // resume both the reconciliation poll and the SSE cursor on reconnect.
  highWaterMark: string;
  close: () => void;
  backoffMs: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  stopped: boolean;
  // Chain of in-flight ingests, so `fetchSince` can await "everything received
  // so far" without racing a message that arrived but hasn't finished
  // normalizing yet (normalizing awaits a memo fetch).
  pending: Promise<void>;
}

/**
 * Streaming implementation of WatcherPort over Horizon's SSE payments feed.
 *
 * The port is pull-based (`fetchSince`), so this doesn't push to the worker —
 * it keeps a live SSE connection per watched account and buffers normalized
 * events locally, so `fetchSince` is served from memory instead of issuing a
 * Horizon request every tick. A dropped connection reconnects with
 * exponential backoff; on reconnect one polled page closes the gap between
 * the last confirmed event and the new stream's first message, and buffering
 * by paging token means an overlap between that page and the stream never
 * double-delivers a payment to the worker.
 */
export class StreamingHorizonWatcher implements WatcherPort {
  private readonly client: HorizonClient;
  private readonly streams = new Map<string, AccountStream>();
  private readonly log: (msg: string) => void;
  private readonly initialBackoffMs: number;
  private readonly maxBackoffMs: number;

  constructor(
    horizonUrlOrClient: string | HorizonClient,
    opts?: { log?: (msg: string) => void; initialBackoffMs?: number; maxBackoffMs?: number },
  ) {
    this.client =
      typeof horizonUrlOrClient === "string" ? realHorizonClient(horizonUrlOrClient) : horizonUrlOrClient;
    this.log = opts?.log ?? (() => {});
    this.initialBackoffMs = opts?.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS;
    this.maxBackoffMs = opts?.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
  }

  async latestCursor(account: string): Promise<string | null> {
    try {
      const page = await this.client.payments().forAccount(account).order("desc").limit(1).call();
      const rec = page.records[0];
      return rec ? rec.paging_token : null;
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async fetchSince(account: string, cursor: string, limit = 200): Promise<NormalizedPayment[]> {
    const stream = this.ensureStream(account, cursor);
    await stream.pending;
    const out = [...stream.buffer.values()]
      .filter((p) => comparePagingToken(p.pagingToken, cursor) > 0)
      .sort((a, b) => comparePagingToken(a.pagingToken, b.pagingToken))
      .slice(0, limit);

    // Once the worker has moved its cursor past an entry, it will never ask
    // for it again (fetchSince is called with a monotonically advancing
    // cursor) — drop it so the buffer doesn't grow forever.
    for (const [token, payment] of stream.buffer) {
      if (comparePagingToken(payment.pagingToken, cursor) <= 0) stream.buffer.delete(token);
    }

    return out;
  }

  /** Tears down every live subscription. Call on process shutdown. */
  stop(): void {
    for (const [account, stream] of this.streams) {
      stream.stopped = true;
      if (stream.reconnectTimer) clearTimeout(stream.reconnectTimer);
      stream.close();
      this.streams.delete(account);
    }
  }

  private ensureStream(account: string, cursor: string): AccountStream {
    const existing = this.streams.get(account);
    if (existing) return existing;

    const stream: AccountStream = {
      buffer: new Map(),
      highWaterMark: cursor,
      close: () => {},
      backoffMs: this.initialBackoffMs,
      reconnectTimer: null,
      stopped: false,
      pending: Promise.resolve(),
    };
    this.streams.set(account, stream);
    this.connect(account, stream, cursor);
    return stream;
  }

  private connect(account: string, stream: AccountStream, fromCursor: string): void {
    stream.close = this.client
      .payments()
      .forAccount(account)
      .cursor(fromCursor)
      .stream({
        onmessage: (record) => {
          stream.pending = stream.pending.then(
            () => this.ingest(stream, record),
            () => this.ingest(stream, record), // a prior ingest failing must not wedge later messages
          );
        },
        onerror: (err) => {
          this.log(`stream ${short(account)} error: ${stringifyErr(err)}`);
          this.scheduleReconnect(account, stream);
        },
      });
  }

  private scheduleReconnect(account: string, stream: AccountStream): void {
    if (stream.stopped || stream.reconnectTimer) return;
    stream.close();
    const delay = stream.backoffMs;
    stream.reconnectTimer = setTimeout(() => {
      stream.reconnectTimer = null;
      void this.reconnect(account, stream);
    }, delay);
    stream.backoffMs = Math.min(stream.backoffMs * 2, this.maxBackoffMs);
  }

  /** Resume from the last persisted cursor, reconciling the gap via one polled page. */
  private async reconnect(account: string, stream: AccountStream): Promise<void> {
    if (stream.stopped) return;
    try {
      let builder = this.client
        .payments()
        .forAccount(account)
        .order("asc")
        .limit(RECONCILE_PAGE_LIMIT);
      if (stream.highWaterMark) builder = builder.cursor(stream.highWaterMark);
      const page = await builder.call();
      // Reaching here means the round-trip to Horizon succeeded, so the outage
      // that triggered this reconnect is over — reset backoff for next time.
      stream.backoffMs = this.initialBackoffMs;
      for (const record of page.records) {
        await this.ingest(stream, record);
      }
    } catch (err) {
      if (!isNotFound(err)) {
        this.log(`reconcile ${short(account)} failed: ${stringifyErr(err)}`);
        this.scheduleReconnect(account, stream);
        return;
      }
    }
    if (stream.stopped) return;
    this.connect(account, stream, stream.highWaterMark);
  }

  private async ingest(stream: AccountStream, record: HorizonPaymentRecord): Promise<void> {
    const normalized = await normalizePayment(record);
    if (comparePagingToken(record.paging_token, stream.highWaterMark) > 0) {
      stream.highWaterMark = record.paging_token;
    }
    if (!normalized) return;
    stream.buffer.set(normalized.pagingToken, normalized);
  }
}

/**
 * Horizon paging tokens are decimal-string TOIDs: safe to compare as BigInt.
 * Falls back to lexicographic comparison for non-numeric tokens (e.g. "").
 */
function comparePagingToken(a: string, b: string): number {
  if (!a && !b) return 0;
  if (!a) return -1;
  if (!b) return 1;
  try {
    const diff = BigInt(a) - BigInt(b);
    return diff < 0n ? -1 : diff > 0n ? 1 : 0;
  } catch {
    return a < b ? -1 : a > b ? 1 : 0;
  }
}

function short(s: string): string {
  return s.length > 12 ? `${s.slice(0, 6)}…${s.slice(-4)}` : s;
}
function stringifyErr(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
