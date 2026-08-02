import { Keypair, StrKey, WebAuth } from "@stellar/stellar-sdk";

export class AuthError extends Error {}

/** An account's ed25519 signers and its medium threshold, as reported by Horizon.
 *  `null` means the account does not exist on-chain yet (unfunded); SEP-10 then
 *  falls back to treating the account id itself as the sole signer. */
export type AccountSigners = { signers: Record<string, number>; medThreshold: number } | null;

export type FetchAccountSigners = (accountId: string) => Promise<AccountSigners>;

export interface ChallengeOptions {
  serverKeypair: Keypair;
  homeDomain: string;
  webAuthDomain: string;
  networkPassphrase: string;
  fetchAccountSigners: FetchAccountSigners;
  /** Challenge validity window in seconds. Default 900 (15 minutes). */
  timeoutSeconds?: number;
}

/**
 * Server-side SEP-10 web authentication: issues challenge transactions and
 * verifies signed ones back. https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0010.md
 *
 * Signature + timebounds + domain checks are delegated to @stellar/stellar-sdk's
 * `WebAuth` (the same primitives the JS SDK uses client-side in
 * packages/offramp/src/sep10.ts); this class adds the single-use nonce store and
 * the M-of-N threshold lookup via Horizon.
 */
export class ChallengeService {
  // tx hash -> epoch-seconds it stops mattering (== the challenge's own maxTime).
  private readonly used = new Map<string, number>();

  constructor(private readonly opts: ChallengeOptions) {}

  build(account: string): { transaction: string; network_passphrase: string } {
    if (!StrKey.isValidEd25519PublicKey(account)) {
      throw new AuthError("account must be a valid Stellar G-address");
    }
    const transaction = WebAuth.buildChallengeTx(
      this.opts.serverKeypair,
      account,
      this.opts.homeDomain,
      this.opts.timeoutSeconds ?? 900,
      this.opts.networkPassphrase,
      this.opts.webAuthDomain,
    );
    return { transaction, network_passphrase: this.opts.networkPassphrase };
  }

  /** Verifies a client-signed challenge and returns the authenticated account id. */
  async verify(transactionXdr: string): Promise<string> {
    this.sweepExpired();

    let clientAccountID: string;
    let hash: string;
    try {
      const read = WebAuth.readChallengeTx(
        transactionXdr,
        this.opts.serverKeypair.publicKey(),
        this.opts.networkPassphrase,
        [this.opts.homeDomain],
        this.opts.webAuthDomain,
      );
      clientAccountID = read.clientAccountID;
      hash = read.tx.hash().toString("hex");
    } catch (err) {
      throw new AuthError(`invalid challenge transaction: ${errMessage(err)}`);
    }

    if (this.used.has(hash)) {
      throw new AuthError("challenge has already been used");
    }

    const account = await this.opts.fetchAccountSigners(clientAccountID);
    try {
      if (account) {
        WebAuth.verifyChallengeTxThreshold(
          transactionXdr,
          this.opts.serverKeypair.publicKey(),
          this.opts.networkPassphrase,
          account.medThreshold,
          // `horizonSignerFetcher` only collects ed25519 signers, so the type is known.
          Object.entries(account.signers).map(([key, weight]) => ({
            key,
            weight,
            type: "ed25519_public_key",
          })),
          [this.opts.homeDomain],
          this.opts.webAuthDomain,
        );
      } else {
        // Unfunded account: SEP-10 falls back to the account id as its own sole signer.
        WebAuth.verifyChallengeTxSigners(
          transactionXdr,
          this.opts.serverKeypair.publicKey(),
          this.opts.networkPassphrase,
          [clientAccountID],
          [this.opts.homeDomain],
          this.opts.webAuthDomain,
        );
      }
    } catch (err) {
      throw new AuthError(`signature verification failed: ${errMessage(err)}`);
    }

    // Single-use: once verified, this exact challenge can never be redeemed again.
    // Kept only until its own timebounds lapse, since it would be rejected anyway.
    this.used.set(hash, Math.floor(Date.now() / 1000) + (this.opts.timeoutSeconds ?? 900));

    return clientAccountID;
  }

  private sweepExpired(): void {
    const now = Math.floor(Date.now() / 1000);
    for (const [hash, exp] of this.used) {
      if (exp < now) this.used.delete(hash);
    }
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
