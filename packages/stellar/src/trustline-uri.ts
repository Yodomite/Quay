import { Asset, BASE_FEE, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import type { AssetRef } from "@checkout/core";

// Derived from TransactionBuilder's own constructor rather than a guessed
// "Account" type-export path — a Horizon.Server.loadAccount() result already
// satisfies this (accountId() + sequenceNumber() + incrementSequenceNumber()).
type TransactionSourceAccount = ConstructorParameters<typeof TransactionBuilder>[0];

/**
 * Builds a SEP-7 `tx` deep link wrapping an unsigned `changeTrust` operation for
 * `asset`, so a seller's wallet can sign it directly (no server-held key ever
 * touches it — we only need the account's current sequence number, which
 * `Horizon.Server.loadAccount()` already gives us for free).
 *
 * Returns `undefined` for native XLM, which has no trustline to add.
 */
export function buildChangeTrustUri(
  account: TransactionSourceAccount,
  asset: AssetRef,
  networkPassphrase: string,
): string | undefined {
  if (asset.issuer === null) return undefined;

  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase })
    .addOperation(Operation.changeTrust({ asset: new Asset(asset.code, asset.issuer) }))
    .setTimeout(300)
    .build();

  const xdr = tx.toXDR();
  return `web+stellar:tx?xdr=${encodeURIComponent(xdr)}&network_passphrase=${encodeURIComponent(networkPassphrase)}`;
}
