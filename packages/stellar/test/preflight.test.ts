import { describe, expect, it } from "vitest";
import { canReceiveAsset } from "../src/preflight";
import { FakeHorizonClient } from "./fake-horizon";

const ACCOUNT = "GDEST0000000000000000000000000000000000000000000000000000";
const ISSUER = "GISSUER000000000000000000000000000000000000000000000000000";
const USDC = { code: "USDC", issuer: ISSUER };
const XLM = { code: "XLM", issuer: null };

describe("canReceiveAsset", () => {
  it("fails when the account does not exist on-chain", async () => {
    const fake = new FakeHorizonClient();
    fake.markNotFound(ACCOUNT);
    const result = await canReceiveAsset(fake, ACCOUNT, USDC);
    expect(result).toEqual({ ok: false, reason: "account does not exist on-chain" });
  });

  it("passes native XLM as soon as the account exists, no trustline needed", async () => {
    const fake = new FakeHorizonClient();
    const result = await canReceiveAsset(fake, ACCOUNT, XLM);
    expect(result.ok).toBe(true);
  });

  it("fails an issued asset with no trustline", async () => {
    const fake = new FakeHorizonClient();
    const result = await canReceiveAsset(fake, ACCOUNT, USDC);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/trustline/);
  });

  it("passes an issued asset with a trustline that has headroom", async () => {
    const fake = new FakeHorizonClient();
    fake.setTrustline(ACCOUNT, {
      asset_type: "credit_alphanum4",
      asset_code: "USDC",
      asset_issuer: ISSUER,
      balance: "10",
      limit: "1000",
    });
    const result = await canReceiveAsset(fake, ACCOUNT, USDC);
    expect(result.ok).toBe(true);
  });

  it("fails an issued asset whose trustline is already at its limit", async () => {
    const fake = new FakeHorizonClient();
    fake.setTrustline(ACCOUNT, {
      asset_type: "credit_alphanum4",
      asset_code: "USDC",
      asset_issuer: ISSUER,
      balance: "1000",
      limit: "1000",
    });
    const result = await canReceiveAsset(fake, ACCOUNT, USDC);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/headroom/);
  });
});
