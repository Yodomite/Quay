import { describe, expect, it } from "vitest";
import { metrics } from "../src/metrics";

// Smoke test: keeps this list in sync with docs/API.md's metrics table. Each
// family renders its HELP/TYPE lines even with zero observations.
const EXPECTED_METRIC_NAMES = [
  "payments_matched_total",
  "link_status_transitions_total",
  "webhook_attempts_total",
  "anchor_calls_total",
  "watcher_tick_duration_seconds",
  "payment_to_paid_latency_seconds",
  "anchor_call_duration_seconds",
  "quote_to_settlement_duration_seconds",
  "accounts_watched",
  "pending_cash_outs",
  "webhook_deliveries_in_flight",
  "offramp_circuit_breaker_state",
  "watcher_lag_seconds",
];

describe("app-wide metrics registry", () => {
  it("registers every documented instrument", () => {
    const rendered = metrics.registry.render();
    for (const name of EXPECTED_METRIC_NAMES) {
      expect(rendered).toContain(`# TYPE ${name} `);
    }
  });
});
