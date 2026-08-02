import { Networks } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { renderStellarToml } from "../src/routes/well-known";

describe("renderStellarToml", () => {
  it("includes the SEP-1 fields SEP-10 discovery depends on", () => {
    const toml = renderStellarToml({
      signingKey: "GSERVERKEY",
      webAuthEndpoint: "https://quay.test/auth",
      networkPassphrase: Networks.TESTNET,
    });

    expect(toml).toContain('SIGNING_KEY="GSERVERKEY"');
    expect(toml).toContain('WEB_AUTH_ENDPOINT="https://quay.test/auth"');
    expect(toml).toContain(`NETWORK_PASSPHRASE="${Networks.TESTNET}"`);
  });
});
