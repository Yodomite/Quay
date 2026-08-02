import { isNative, type AssetRef } from "@checkout/core";
import { type HorizonClient, isNotFound, realHorizonClient } from "./horizon-client";

export interface PreflightResult {
  ok: boolean;
  reason?: string;
}

/**
 * Verifies the underlying G-account can actually receive `asset`: it must
 * exist on-chain, and for issued assets it must hold a trustline to the
 * issuer with headroom. Used before handing out a muxed (M...) destination —
 * a payment that lands on-chain but the base account can't actually receive
 * is worse than failing at link-creation time.
 */
export async function canReceiveAsset(
  horizonUrlOrClient: string | HorizonClient,
  account: string,
  asset: AssetRef,
): Promise<PreflightResult> {
  const client =
    typeof horizonUrlOrClient === "string" ? realHorizonClient(horizonUrlOrClient) : horizonUrlOrClient;

  let horizonAccount;
  try {
    horizonAccount = await client.loadAccount(account);
  } catch (err) {
    if (isNotFound(err)) return { ok: false, reason: "account does not exist on-chain" };
    throw err;
  }

  if (isNative(asset)) return { ok: true };

  const line = horizonAccount.balances.find(
    (b) =>
      (b.asset_type === "credit_alphanum4" || b.asset_type === "credit_alphanum12") &&
      b.asset_code === asset.code &&
      b.asset_issuer === asset.issuer,
  );
  if (!line) return { ok: false, reason: `no trustline to ${asset.code}:${asset.issuer}` };

  const headroom = Number(line.limit) - Number(line.balance);
  if (Number.isFinite(headroom) && headroom <= 0) {
    return { ok: false, reason: `trustline to ${asset.code} has no headroom` };
  }
  return { ok: true };
}
