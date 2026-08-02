import type { AssetRef, CannotReceiveReason } from "@checkout/core";

/** The subset of a Horizon balance-line entry the trustline check needs —
 *  kept minimal and independent of any specific stellar-sdk type export path. */
export interface BalanceLine {
  asset_type: string;
  asset_code?: string;
  asset_issuer?: string;
  balance: string;
  limit?: string;
  is_authorized?: boolean;
}

/** Finds the balance line for `asset` among an account's balances, if any. */
export function findAssetBalance(balances: readonly BalanceLine[], asset: AssetRef): BalanceLine | undefined {
  return balances.find((b) => "asset_code" in b && b.asset_code === asset.code && "asset_issuer" in b && b.asset_issuer === asset.issuer);
}

/**
 * Pure decision: given an (already-fetched) balance line for an issued asset —
 * or `undefined` if none exists — returns the reason the account can't receive
 * it, or `null` if it can. No network I/O; this is the part worth unit-testing
 * in isolation, same spirit as `matchPayment` in packages/core.
 */
export function checkBalance(balance: BalanceLine | undefined, _asset: AssetRef): CannotReceiveReason | null {
  if (!balance) return "no_trustline";
  if (balance.is_authorized === false) return "trustline_not_authorized";
  if (balance.limit !== undefined && Number(balance.balance) >= Number(balance.limit)) return "trustline_limit_exceeded";
  return null;
}

export function messageFor(reason: CannotReceiveReason, account: string, asset: AssetRef, balance?: BalanceLine): string {
  switch (reason) {
    case "account_not_found":
      return (
        `Account ${account} does not exist on-chain yet — it must be created and funded with at ` +
        "least the minimum XLM reserve before it can receive payments."
      );
    case "no_trustline":
      return `Account ${account} has no trustline for ${asset.code} (issuer ${asset.issuer}) — add one before this link can be paid.`;
    case "trustline_not_authorized":
      return `The ${asset.code} trustline on ${account} is not authorized by the issuer (frozen/deauthorized).`;
    case "trustline_limit_exceeded":
      return `The ${asset.code} trustline on ${account} is already at its limit (${balance?.limit}) — raise it to receive more.`;
  }
}
