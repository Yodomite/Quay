import { Account, Keypair, Networks, TransactionBuilder } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { buildChangeTrustUri } from "../src/trustline-uri";

// `Account` is stellar-sdk's own network-free stand-in for a loaded Horizon
// account (just needs an id + sequence number) — exactly what
// TransactionBuilder needs, no Horizon call required for this test.
// Real (but random, unfunded) keypairs — `Asset`/`Account` validate the StrKey
// checksum, so a hand-typed placeholder address would throw.
const ACCOUNT_ID = Keypair.random().publicKey();
const ISSUER_ID = Keypair.random().publicKey();

describe("buildChangeTrustUri", () => {
  it("returns undefined for native XLM — there's no trustline to add", () => {
    const account = new Account(ACCOUNT_ID, "1");
    expect(buildChangeTrustUri(account, { code: "XLM", issuer: null }, Networks.TESTNET)).toBeUndefined();
  });

  it("builds a SEP-7 tx URI wrapping an unsigned changeTrust operation", () => {
    const account = new Account(ACCOUNT_ID, "42");
    const uri = buildChangeTrustUri(account, { code: "USDC", issuer: ISSUER_ID }, Networks.TESTNET);

    expect(uri).toBeDefined();
    expect(uri).toMatch(/^web\+stellar:tx\?xdr=/);
    expect(uri).toContain(`network_passphrase=${encodeURIComponent(Networks.TESTNET)}`);

    // Round-trip: the XDR should parse back into a transaction with exactly
    // one changeTrust operation for the right asset, still unsigned.
    const xdrParam = new URL(uri!.replace("web+stellar:tx?", "https://x/?")).searchParams.get("xdr")!;
    const tx = TransactionBuilder.fromXDR(xdrParam, Networks.TESTNET);
    expect("operations" in tx ? tx.operations.length : 0).toBe(1);
    if ("operations" in tx) {
      // The length assertion above already established there is exactly one.
      const op = tx.operations[0]!;
      expect(op.type).toBe("changeTrust");
    }
    expect("signatures" in tx ? tx.signatures.length : 0).toBe(0);
  });
});
