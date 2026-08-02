import { describe, expect, it } from "vitest";
import { Counter, Gauge, Histogram, Registry } from "../src/metrics";

describe("Counter", () => {
  it("increments by 1 by default and renders HELP/TYPE + value", () => {
    const c = new Counter("things_total", "Things counted.");
    c.inc();
    c.inc();
    expect(c.render()).toBe(["# HELP things_total Things counted.", "# TYPE things_total counter", "things_total 2"].join("\n"));
  });

  it("tracks separate series per label combination", () => {
    const c = new Counter("payments_matched_total", "help", ["outcome"]);
    c.inc({ outcome: "paid" });
    c.inc({ outcome: "paid" }, 2);
    c.inc({ outcome: "no_memo" });
    const rendered = c.render();
    expect(rendered).toContain('payments_matched_total{outcome="paid"} 3');
    expect(rendered).toContain('payments_matched_total{outcome="no_memo"} 1');
  });

  it("rejects a negative increment", () => {
    const c = new Counter("x", "help");
    expect(() => c.inc(-1)).toThrow(/non-negative/);
  });

  it("escapes label values", () => {
    const c = new Counter("x", "help", ["reason"]);
    c.inc({ reason: 'a "quoted" value\nwith newline' });
    expect(c.render()).toContain('reason="a \\"quoted\\" value\\nwith newline"');
  });
});

describe("Gauge", () => {
  it("supports set/inc/dec without labels", () => {
    const g = new Gauge("depth", "help");
    g.set(5);
    expect(g.render()).toContain("depth 5");
    g.inc();
    expect(g.render()).toContain("depth 6");
    g.dec(2);
    expect(g.render()).toContain("depth 4");
  });

  it("supports labeled series", () => {
    const g = new Gauge("state", "help", ["kind"]);
    g.set({ kind: "a" }, 1);
    g.set({ kind: "b" }, 2);
    const rendered = g.render();
    expect(rendered).toContain('state{kind="a"} 1');
    expect(rendered).toContain('state{kind="b"} 2');
  });
});

describe("Histogram", () => {
  it("makes bucket counts cumulative and tracks sum/count", () => {
    const h = new Histogram("latency_seconds", "help", [1, 5, 10]);
    h.observe(0.5);
    h.observe(3);
    h.observe(20);

    const rendered = h.render();
    expect(rendered).toContain('latency_seconds_bucket{le="1"} 1'); // only 0.5
    expect(rendered).toContain('latency_seconds_bucket{le="5"} 2'); // 0.5, 3
    expect(rendered).toContain('latency_seconds_bucket{le="10"} 2'); // still just 0.5, 3
    expect(rendered).toContain('latency_seconds_bucket{le="+Inf"} 3'); // all three
    expect(rendered).toContain("latency_seconds_sum 23.5");
    expect(rendered).toContain("latency_seconds_count 3");
  });

  it("keeps separate bucket state per label combination", () => {
    const h = new Histogram("call_seconds", "help", [1, 2], ["method"]);
    h.observe({ method: "quote" }, 0.5);
    h.observe({ method: "status" }, 1.5);
    const rendered = h.render();
    expect(rendered).toContain('call_seconds_bucket{method="quote",le="1"} 1');
    expect(rendered).toContain('call_seconds_bucket{method="status",le="1"} 0');
    expect(rendered).toContain('call_seconds_bucket{method="status",le="2"} 1');
  });
});

describe("Registry", () => {
  it("renders every registered metric, each ending in a newline-joined block", () => {
    const registry = new Registry();
    const c = registry.counter("a_total", "help a");
    const g = registry.gauge("b", "help b");
    c.inc();
    g.set(3);

    const rendered = registry.render();
    expect(rendered).toContain("# TYPE a_total counter");
    expect(rendered).toContain("# TYPE b gauge");
    expect(rendered.endsWith("\n")).toBe(true);
  });
});
