import { describe, expect, it } from "vitest";
import { checkBalance, findAssetBalance, messageFor, type BalanceLine } from "../src/trustline-check";

const USDC = { code: "USDC", issuer: "GISSUER" };

describe("findAssetBalance", () => {
  it("finds the matching asset among several balance lines", () => {
    const balances: BalanceLine[] = [
      { asset_type: "native", balance: "50" },
      { asset_type: "credit_alphanum4", asset_code: "USDC", asset_issuer: "GISSUER", balance: "10", limit: "1000" },
      { asset_type: "credit_alphanum4", asset_code: "USDC", asset_issuer: "GOTHER", balance: "5", limit: "1000" },
    ];
    const found = findAssetBalance(balances, USDC);
    expect(found?.balance).toBe("10");
  });

  it("returns undefined when there's no matching trustline", () => {
    const balances: BalanceLine[] = [{ asset_type: "native", balance: "50" }];
    expect(findAssetBalance(balances, USDC)).toBeUndefined();
  });
});

describe("checkBalance", () => {
  it("returns no_trustline when there's no balance line at all", () => {
    expect(checkBalance(undefined, USDC)).toBe("no_trustline");
  });

  it("returns trustline_not_authorized when the issuer froze it", () => {
    const balance: BalanceLine = { asset_type: "credit_alphanum4", balance: "10", limit: "1000", is_authorized: false };
    expect(checkBalance(balance, USDC)).toBe("trustline_not_authorized");
  });

  it("returns trustline_limit_exceeded when balance has reached the limit", () => {
    const balance: BalanceLine = { asset_type: "credit_alphanum4", balance: "1000", limit: "1000", is_authorized: true };
    expect(checkBalance(balance, USDC)).toBe("trustline_limit_exceeded");
  });

  it("returns null (can receive) for a normal, under-limit, authorized trustline", () => {
    const balance: BalanceLine = { asset_type: "credit_alphanum4", balance: "10", limit: "1000", is_authorized: true };
    expect(checkBalance(balance, USDC)).toBeNull();
  });

  it("treats a missing limit as unbounded, not exceeded", () => {
    const balance: BalanceLine = { asset_type: "credit_alphanum4", balance: "999999", is_authorized: true };
    expect(checkBalance(balance, USDC)).toBeNull();
  });
});

describe("messageFor", () => {
  it("names the missing trustline's issuer for no_trustline", () => {
    const msg = messageFor("no_trustline", "GACCOUNT", USDC);
    expect(msg).toContain("USDC");
    expect(msg).toContain("GISSUER");
  });

  it("names the account for account_not_found", () => {
    expect(messageFor("account_not_found", "GACCOUNT", USDC)).toContain("GACCOUNT");
  });
});
