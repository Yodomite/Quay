import { describe, expect, it } from "vitest";
import { StrKey } from "@stellar/stellar-sdk";
import { muxedFor, StellarRail } from "../src/stellar-rail";

const DEST = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
const ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const CFG = { network: "testnet" as const, horizonUrl: "https://horizon-testnet.stellar.org", networkPassphrase: "Test SDF Network ; September 2015", usdcIssuer: ISSUER };

describe("muxedFor", () => {
  it("encodes a valid M-address from a G-address and an id", () => {
    const m = muxedFor(DEST, "123456789");
    expect(m.startsWith("M")).toBe(true);
    expect(StrKey.isValidMed25519PublicKey(m)).toBe(true);
  });

  it("rejects a non-G-address account", () => {
    expect(() => muxedFor("not-an-address", "1")).toThrow();
  });
});

describe("StellarRail.buildRequest — memo mode (default, unchanged)", () => {
  const rail = new StellarRail(CFG);

  it("builds a memo-carrying request against the plain G-address", () => {
    const req = rail.buildRequest({
      destination: DEST,
      amount: "10",
      asset: { code: "USDC", issuer: ISSUER },
      reference: "pl_abc123",
      message: "Order",
    });
    expect(req.destination).toBe(DEST);
    expect(req.memo).toBe("pl_abc123");
    expect(req.uri).toContain(`destination=${DEST}`);
    expect(req.uri).toContain("memo=pl_abc123");
    expect(req.uri).toContain("memo_type=MEMO_TEXT");
  });

  it("is unaffected by an absent muxedId (explicit null behaves like undefined)", () => {
    const withUndefined = rail.buildRequest({
      destination: DEST,
      amount: "10",
      asset: { code: "USDC", issuer: ISSUER },
      reference: "pl_abc123",
    });
    const withNull = rail.buildRequest({
      destination: DEST,
      amount: "10",
      asset: { code: "USDC", issuer: ISSUER },
      reference: "pl_abc123",
      muxedId: null,
    });
    expect(withNull).toEqual(withUndefined);
  });
});

describe("StellarRail.buildRequest — muxed mode", () => {
  const rail = new StellarRail(CFG);

  it("builds against an M-address with no memo", () => {
    const req = rail.buildRequest({
      destination: DEST,
      amount: "10",
      asset: { code: "USDC", issuer: ISSUER },
      reference: "pl_abc123", // ignored for correlation purposes in muxed mode
      muxedId: "123456789",
    });
    expect(req.destination.startsWith("M")).toBe(true);
    expect(req.memo).toBeNull();
    expect(req.uri).not.toContain("memo=");
    expect(req.uri).not.toContain("memo_type=");
    expect(req.uri).toContain(`destination=${req.destination}`);
  });
});
