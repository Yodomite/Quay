import { Keypair, Networks, TransactionBuilder } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { AuthError, ChallengeService, type FetchAccountSigners } from "../src/services/challenge";

const HOME_DOMAIN = "quay.test";
const WEB_AUTH_DOMAIN = "quay.test";
const NETWORK_PASSPHRASE = Networks.TESTNET;

// No account in these tests is ever funded on-chain, so every lookup falls back
// to the "account id is its own sole signer" SEP-10 path — no network call.
const noAccountsExist: FetchAccountSigners = async () => null;

function makeService(fetchAccountSigners: FetchAccountSigners = noAccountsExist) {
  return new ChallengeService({
    serverKeypair: Keypair.random(),
    homeDomain: HOME_DOMAIN,
    webAuthDomain: WEB_AUTH_DOMAIN,
    networkPassphrase: NETWORK_PASSPHRASE,
    fetchAccountSigners,
  });
}

describe("ChallengeService", () => {
  it("build() issues a challenge the client can sign and the server can verify", async () => {
    const service = makeService();
    const client = Keypair.random();

    const { transaction, network_passphrase } = service.build(client.publicKey());
    expect(network_passphrase).toBe(NETWORK_PASSPHRASE);

    const tx = TransactionBuilder.fromXDR(transaction, network_passphrase);
    tx.sign(client);

    const account = await service.verify(tx.toXDR());
    expect(account).toBe(client.publicKey());
  });

  it("rejects an unsigned challenge", async () => {
    const service = makeService();
    const client = Keypair.random();

    const { transaction, network_passphrase } = service.build(client.publicKey());
    // Never signed by the client — only the server's own signature is present.
    await expect(service.verify(TransactionBuilder.fromXDR(transaction, network_passphrase).toXDR())).rejects.toThrow(
      AuthError,
    );
  });

  it("rejects a replayed challenge — the same signed transaction can't be redeemed twice", async () => {
    const service = makeService();
    const client = Keypair.random();

    const { transaction, network_passphrase } = service.build(client.publicKey());
    const tx = TransactionBuilder.fromXDR(transaction, network_passphrase);
    tx.sign(client);
    const signedXdr = tx.toXDR();

    await expect(service.verify(signedXdr)).resolves.toBe(client.publicKey());
    await expect(service.verify(signedXdr)).rejects.toThrow(/already been used/);
  });

  it("rejects a challenge signed by the wrong account", async () => {
    const service = makeService();
    const claimedAccount = Keypair.random();
    const impostor = Keypair.random();

    const { transaction, network_passphrase } = service.build(claimedAccount.publicKey());
    const tx = TransactionBuilder.fromXDR(transaction, network_passphrase);
    tx.sign(impostor); // signs with a different key than the one named in the challenge

    await expect(service.verify(tx.toXDR())).rejects.toThrow(AuthError);
  });

  it("rejects a challenge whose server signature was tampered with", async () => {
    const service = makeService();
    const otherServer = new ChallengeService({
      serverKeypair: Keypair.random(),
      homeDomain: HOME_DOMAIN,
      webAuthDomain: WEB_AUTH_DOMAIN,
      networkPassphrase: NETWORK_PASSPHRASE,
      fetchAccountSigners: noAccountsExist,
    });
    const client = Keypair.random();

    // A challenge minted by a different server key must never verify against ours.
    const { transaction, network_passphrase } = otherServer.build(client.publicKey());
    const tx = TransactionBuilder.fromXDR(transaction, network_passphrase);
    tx.sign(client);

    await expect(service.verify(tx.toXDR())).rejects.toThrow(AuthError);
  });

  it("enforces M-of-N thresholds when the client account exists on-chain", async () => {
    const signerA = Keypair.random();
    const signerB = Keypair.random();
    const client = Keypair.random();

    const service = makeService(async (accountId) => {
      if (accountId !== client.publicKey()) return null;
      // Medium threshold 20, two signers of weight 10 each — neither alone suffices.
      return { signers: { [signerA.publicKey()]: 10, [signerB.publicKey()]: 10 }, medThreshold: 20 };
    });

    const { transaction, network_passphrase } = service.build(client.publicKey());
    const tx = TransactionBuilder.fromXDR(transaction, network_passphrase);
    tx.sign(signerA); // one signer, weight 10 < threshold 20

    await expect(service.verify(tx.toXDR())).rejects.toThrow(AuthError);

    const tx2 = TransactionBuilder.fromXDR(transaction, network_passphrase);
    tx2.sign(signerA);
    tx2.sign(signerB); // now 20 >= threshold 20

    await expect(service.verify(tx2.toXDR())).resolves.toBe(client.publicKey());
  });
});
