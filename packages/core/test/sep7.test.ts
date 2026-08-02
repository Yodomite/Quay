import { describe, it, expect } from "vitest";
import { buildSep7PayUri } from "../src/sep7/build-uri";
import { XLM } from "../src/domain/payment-link";

const DEST = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
const ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

describe("SEP-7 build-uri", () => {
  it("builds a USDC pay URI with all params", () => {
    const uri = buildSep7PayUri({
      destination: DEST,
      amount: "25.5",
      asset: { code: "USDC", issuer: ISSUER },
      memo: "ref_abc123",
      message: "Order 42",
    });
    expect(uri.startsWith("web+stellar:pay?")).toBe(true);
    expect(uri).toContain(`destination=${DEST}`);
    expect(uri).toContain("amount=25.5");
    expect(uri).toContain("asset_code=USDC");
    expect(uri).toContain(`asset_issuer=${ISSUER}`);
    expect(uri).toContain("memo=ref_abc123");
    expect(uri).toContain("memo_type=MEMO_TEXT");
    expect(uri).toContain("msg=Order%2042"); // space encoded as %20, not +
  });

  it("omits asset_code/asset_issuer for native XLM", () => {
    const uri = buildSep7PayUri({ destination: DEST, amount: "1", asset: XLM });
    expect(uri).not.toContain("asset_code");
    expect(uri).not.toContain("asset_issuer");
  });

  it("can pin a network passphrase", () => {
    const uri = buildSep7PayUri({
      destination: DEST,
      asset: XLM,
      networkPassphrase: "Test SDF Network ; September 2015",
    });
    expect(uri).toContain("network_passphrase=Test%20SDF%20Network%20%3B%20September%202015");
  });

  it("rejects a bad destination", () => {
    expect(() => buildSep7PayUri({ destination: "nope", asset: XLM })).toThrow();
  });

  it("accepts an SEP-23 M-address destination with no memo", () => {
    // 69-char M-address (SEP-23 muxed account); no real checksum needed here
    // since build-uri only checks shape, not validity — StellarRail/StrKey do that.
    const mAddress = "M" + "A".repeat(68);
    const uri = buildSep7PayUri({ destination: mAddress, amount: "10", asset: XLM });
    expect(uri).toContain(`destination=${mAddress}`);
    expect(uri).not.toContain("memo=");
  });

  it("rejects a MEMO_TEXT over 28 bytes", () => {
    expect(() =>
      buildSep7PayUri({ destination: DEST, asset: XLM, memo: "x".repeat(29) }),
    ).toThrow();
  });

  it("rejects an invalid amount", () => {
    expect(() =>
      buildSep7PayUri({ destination: DEST, asset: XLM, amount: "1.123456789" }),
    ).toThrow();
  });
});
