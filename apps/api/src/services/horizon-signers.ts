import { Horizon } from "@stellar/stellar-sdk";
import type { AccountSigners, FetchAccountSigners } from "./challenge";

/** Default `FetchAccountSigners` for `ChallengeService`: looks up an account's
 *  ed25519 signers and medium threshold on Horizon, for the SEP-10 M-of-N check. */
export function horizonSignerFetcher(horizonUrl: string): FetchAccountSigners {
  const server = new Horizon.Server(horizonUrl);
  return async (accountId: string): Promise<AccountSigners> => {
    try {
      const account = await server.loadAccount(accountId);
      const signers: Record<string, number> = {};
      for (const s of account.signers) {
        if (s.type === "ed25519_public_key" && s.weight > 0) signers[s.key] = s.weight;
      }
      return { signers, medThreshold: account.thresholds.med_threshold };
    } catch (err) {
      if (isNotFound(err)) return null; // unfunded account — not yet on-chain
      throw err;
    }
  };
}

function isNotFound(err: unknown): boolean {
  const e = err as { response?: { status?: number }; name?: string };
  return e?.response?.status === 404 || e?.name === "NotFoundError";
}
