// Minimal dependency-free Prometheus text-exposition client (same philosophy as
// the hand-rolled .env loader in env.ts — no need for `prom-client` here).
// https://prometheus.io/docs/instrumenting/exposition_formats/

type Labels = Record<string, string>;

function labelsKey(labelNames: readonly string[], labels: Labels): string {
  // JSON-encode each value so no separator choice can create a collision
  // between different label combinations (e.g. {a:"1",b:"23"} vs {a:"12",b:"3"}).
  return labelNames.map((k) => JSON.stringify(labels[k] ?? "")).join(",");
}

function escapeLabelValue(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function formatLabels(labelNames: readonly string[], labels: Labels): string {
  if (labelNames.length === 0) return "";
  return `{${labelNames.map((k) => `${k}="${escapeLabelValue(labels[k] ?? "")}"`).join(",")}}`;
}

/** Formats a number the way Prometheus expects — no scientific notation for
 *  ordinary magnitudes, `Infinity`/`NaN` spelled out. */
function formatValue(v: number): string {
  if (Number.isNaN(v)) return "NaN";
  if (v === Infinity) return "+Inf";
  if (v === -Infinity) return "-Inf";
  return String(v);
}

export class Counter {
  private readonly data = new Map<string, { labels: Labels; value: number }>();

  constructor(
    readonly name: string,
    readonly help: string,
    readonly labelNames: readonly string[] = [],
  ) {}

  inc(): void;
  inc(value: number): void;
  inc(labels: Labels, value?: number): void;
  inc(a?: number | Labels, b?: number): void {
    let labels: Labels = {};
    let value = 1;
    if (typeof a === "number") value = a;
    else if (a) {
      labels = a;
      value = b ?? 1;
    }
    if (value < 0) throw new Error(`Counter "${this.name}": increment must be non-negative, got ${value}`);
    const key = labelsKey(this.labelNames, labels);
    const cur = this.data.get(key)?.value ?? 0;
    this.data.set(key, { labels, value: cur + value });
  }

  reset(): void {
    this.data.clear();
  }

  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    for (const { labels, value } of this.data.values()) {
      lines.push(`${this.name}${formatLabels(this.labelNames, labels)} ${formatValue(value)}`);
    }
    return lines.join("\n");
  }
}

export class Gauge {
  private readonly data = new Map<string, { labels: Labels; value: number }>();

  constructor(
    readonly name: string,
    readonly help: string,
    readonly labelNames: readonly string[] = [],
  ) {}

  set(value: number): void;
  set(labels: Labels, value: number): void;
  set(a: number | Labels, b?: number): void {
    const [labels, value] = typeof a === "number" ? [{}, a] : [a, b as number];
    this.data.set(labelsKey(this.labelNames, labels), { labels, value });
  }

  inc(delta = 1, labels: Labels = {}): void {
    const key = labelsKey(this.labelNames, labels);
    const cur = this.data.get(key)?.value ?? 0;
    this.data.set(key, { labels, value: cur + delta });
  }

  dec(delta = 1, labels: Labels = {}): void {
    this.inc(-delta, labels);
  }

  reset(): void {
    this.data.clear();
  }

  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} gauge`];
    for (const { labels, value } of this.data.values()) {
      lines.push(`${this.name}${formatLabels(this.labelNames, labels)} ${formatValue(value)}`);
    }
    return lines.join("\n");
  }
}

interface HistogramEntry {
  labels: Labels;
  bucketCounts: number[]; // parallel to `buckets`, already cumulative (see observe())
  sum: number;
  count: number;
}

export class Histogram {
  private readonly data = new Map<string, HistogramEntry>();
  private readonly buckets: readonly number[];

  constructor(
    readonly name: string,
    readonly help: string,
    buckets: readonly number[],
    readonly labelNames: readonly string[] = [],
  ) {
    this.buckets = [...buckets].sort((a, b) => a - b);
  }

  observe(value: number): void;
  observe(labels: Labels, value: number): void;
  observe(a: number | Labels, b?: number): void {
    const [labels, value] = typeof a === "number" ? [{}, a] : [a, b as number];
    const key = labelsKey(this.labelNames, labels);
    let entry = this.data.get(key);
    if (!entry) {
      entry = { labels, bucketCounts: new Array(this.buckets.length).fill(0), sum: 0, count: 0 };
      this.data.set(key, entry);
    }
    entry.sum += value;
    entry.count += 1;
    // Every bucket >= value gets +1 — that's cumulative-by-construction, so
    // bucketCounts[i] already holds "observations <= buckets[i]" at render time.
    for (let i = 0; i < this.buckets.length; i++) {
      // `i` is bounded by buckets.length, and bucketCounts is constructed with
      // exactly that length above — both indices are always populated.
      if (value <= this.buckets[i]!) entry.bucketCounts[i] = entry.bucketCounts[i]! + 1;
    }
  }

  reset(): void {
    this.data.clear();
  }

  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const entry of this.data.values()) {
      for (let i = 0; i < this.buckets.length; i++) {
        const leLabels = { ...entry.labels, le: String(this.buckets[i]) };
        lines.push(`${this.name}_bucket${formatLabels([...this.labelNames, "le"], leLabels)} ${formatValue(entry.bucketCounts[i]!)}`);
      }
      const infLabels = { ...entry.labels, le: "+Inf" };
      lines.push(`${this.name}_bucket${formatLabels([...this.labelNames, "le"], infLabels)} ${formatValue(entry.count)}`);
      const suffixLabels = formatLabels(this.labelNames, entry.labels);
      lines.push(`${this.name}_sum${suffixLabels} ${formatValue(entry.sum)}`);
      lines.push(`${this.name}_count${suffixLabels} ${formatValue(entry.count)}`);
    }
    return lines.join("\n");
  }
}

type Metric = Counter | Gauge | Histogram;

export class Registry {
  private readonly metrics: Metric[] = [];

  counter(name: string, help: string, labelNames: readonly string[] = []): Counter {
    const c = new Counter(name, help, labelNames);
    this.metrics.push(c);
    return c;
  }

  gauge(name: string, help: string, labelNames: readonly string[] = []): Gauge {
    const g = new Gauge(name, help, labelNames);
    this.metrics.push(g);
    return g;
  }

  histogram(name: string, help: string, buckets: readonly number[], labelNames: readonly string[] = []): Histogram {
    const h = new Histogram(name, help, buckets, labelNames);
    this.metrics.push(h);
    return h;
  }

  /** Prometheus text exposition format (version 0.0.4). */
  render(): string {
    return this.metrics.map((m) => m.render()).join("\n\n") + "\n";
  }
}

// ---------------------------------------------------------------------------
// App-wide instruments. Instrumented at call sites in apps/api (worker,
// services) — packages/core|stellar|offramp stay metrics-agnostic, matching
// the ports-and-adapters boundary the rest of the app already keeps.
// ---------------------------------------------------------------------------

const registry = new Registry();

const paymentsMatchedTotal = registry.counter(
  "payments_matched_total",
  "Incoming payments matched by outcome (paid, underpaid, asset_mismatch, no_memo, unknown_reference).",
  ["outcome"],
);

const linkStatusTransitionsTotal = registry.counter(
  "link_status_transitions_total",
  "Payment link status transitions.",
  ["to"],
);

const webhookAttemptsTotal = registry.counter(
  "webhook_attempts_total",
  "Webhook delivery attempts (each retry counts separately) by result.",
  ["result"], // "ok" | "error"
);

const anchorCallsTotal = registry.counter(
  "anchor_calls_total",
  'Off-ramp adapter calls by method (quote~SEP-38, initiate/status~SEP-6) and result.',
  ["method", "status"], // status: "ok" | "error"
);

const watcherTickDurationSeconds = registry.histogram(
  "watcher_tick_duration_seconds",
  "Duration of one watcher poll tick across all watched accounts.",
  [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30],
);

const paymentToPaidLatencySeconds = registry.histogram(
  "payment_to_paid_latency_seconds",
  "Time from an on-chain payment's ledger close time to its link flipping to paid.",
  [1, 5, 15, 30, 60, 120, 300, 600, 1800],
);

const anchorCallDurationSeconds = registry.histogram(
  "anchor_call_duration_seconds",
  "Off-ramp adapter call latency by method.",
  [0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60],
  ["method"],
);

const quoteToSettlementDurationSeconds = registry.histogram(
  "quote_to_settlement_duration_seconds",
  "Time from cash-out initiation (quote accepted) to anchor settlement.",
  [5, 15, 30, 60, 120, 300, 600, 1800, 3600, 7200],
  ["outcome"], // "settled" | "failed"
);

const accountsWatched = registry.gauge("accounts_watched", "Distinct destination accounts the watcher is currently polling.");
const pendingCashOuts = registry.gauge("pending_cash_outs", "Links currently in offramp_pending.");
const webhookQueueDepth = registry.gauge(
  "webhook_deliveries_in_flight",
  "Webhook deliveries currently being attempted, including in-progress retries.",
);
const circuitBreakerState = registry.gauge(
  "offramp_circuit_breaker_state",
  "Off-ramp adapter circuit breaker state: 0=closed, 1=half_open, 2=open.",
);
const watcherLagSeconds = registry.gauge(
  "watcher_lag_seconds",
  "Seconds since the watcher's last completed poll tick across all accounts.",
);

export const metrics = {
  registry,
  paymentsMatchedTotal,
  linkStatusTransitionsTotal,
  webhookAttemptsTotal,
  anchorCallsTotal,
  watcherTickDurationSeconds,
  paymentToPaidLatencySeconds,
  anchorCallDurationSeconds,
  quoteToSettlementDurationSeconds,
  accountsWatched,
  pendingCashOuts,
  webhookQueueDepth,
  circuitBreakerState,
  watcherLagSeconds,
};
