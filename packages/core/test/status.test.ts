import { describe, it, expect } from "vitest";
import { canTransition, assertTransition, isTerminal } from "../src/domain/status";

describe("status transitions", () => {
  it("allows the happy path active -> paid -> offramp_pending -> offramp_settled", () => {
    expect(canTransition("active", "paid")).toBe(true);
    expect(canTransition("paid", "offramp_pending")).toBe(true);
    expect(canTransition("offramp_pending", "offramp_settled")).toBe(true);
  });

  it("allows off-ramp retry after failure", () => {
    expect(canTransition("offramp_pending", "offramp_failed")).toBe(true);
    expect(canTransition("offramp_failed", "offramp_pending")).toBe(true);
  });

  it("forbids skipping payment", () => {
    expect(canTransition("active", "offramp_pending")).toBe(false);
    expect(() => assertTransition("active", "offramp_settled")).toThrow();
  });

  it("forbids leaving terminal states", () => {
    expect(canTransition("offramp_settled", "paid")).toBe(false);
    expect(canTransition("cancelled", "active")).toBe(false);
    expect(canTransition("expired", "paid")).toBe(false);
  });

  it("identifies terminal states", () => {
    expect(isTerminal("offramp_settled")).toBe(true);
    expect(isTerminal("cancelled")).toBe(true);
    expect(isTerminal("expired")).toBe(true);
    expect(isTerminal("active")).toBe(false);
    expect(isTerminal("paid")).toBe(false);
  });

  // Issue #3 — drive the expired and cancelled transitions.

  it("permits active -> expired", () => {
    expect(canTransition("active", "expired")).toBe(true);
    expect(() => assertTransition("active", "expired")).not.toThrow();
  });

  it("permits active -> cancelled", () => {
    expect(canTransition("active", "cancelled")).toBe(true);
    expect(() => assertTransition("active", "cancelled")).not.toThrow();
  });

  it("permits underpaid -> expired (timeout can still fire after a partial payment)", () => {
    expect(canTransition("underpaid", "expired")).toBe(true);
  });

  it("permits underpaid -> cancelled (seller can still void an underpaid link)", () => {
    expect(canTransition("underpaid", "cancelled")).toBe(true);
  });

  it("FORBIDS cancelling a paid link — once paid, must go through the off-ramp", () => {
    expect(canTransition("paid", "cancelled")).toBe(false);
    expect(() => assertTransition("paid", "cancelled")).toThrow(/Illegal link status transition: paid -> cancelled/);
  });

  it("FORBIDS cancelling a link that is already offramp_pending", () => {
    expect(canTransition("offramp_pending", "cancelled")).toBe(false);
    expect(() => assertTransition("offramp_pending", "cancelled")).toThrow();
  });

  it("FORBIDS expiring a paid link", () => {
    expect(canTransition("paid", "expired")).toBe(false);
    expect(() => assertTransition("paid", "expired")).toThrow();
  });

  it("FORBIDS any transition out of expired and cancelled (they are terminal)", () => {
    for (const from of ["expired", "cancelled"] as const) {
      for (const to of ["active", "paid", "underpaid", "expired", "cancelled", "offramp_pending"] as const) {
        expect(canTransition(from, to)).toBe(false);
      }
    }
    expect(() => assertTransition("expired", "active")).toThrow();
    expect(() => assertTransition("cancelled", "active")).toThrow();
  });
});
