import type { AssetRef } from "../domain/payment-link";
import { isNative } from "../domain/payment-link";
import { isValidAmount } from "../domain/money";

// SEP-0007: "URI Scheme to facilitate delegated signing".
// We build the `pay` operation URI:
//   web+stellar:pay?destination=G...&amount=10&asset_code=USDC&asset_issuer=G...&memo=...&memo_type=MEMO_TEXT
//
// Notes that matter for correctness:
// - Native XLM: omit asset_code AND asset_issuer entirely.
// - memo for MEMO_TEXT must be <= 28 bytes (UTF-8). We use the link's short reference.
// - We hand-encode the query (encodeURIComponent) so spaces become %20, per the spec's
//   examples, rather than the `+` that URLSearchParams would emit.

export type MemoType = "MEMO_TEXT" | "MEMO_ID" | "MEMO_HASH" | "MEMO_RETURN";

export interface Sep7PayParams {
  destination: string; // G-address funds are sent to
  amount?: string; // decimal string; omit to let the payer choose
  asset: AssetRef;
  memo?: string;
  memoType?: MemoType;
  /** Human-readable message shown by the wallet (the "msg" param). */
  message?: string;
  /** Network passphrase to pin testnet/public so wallets don't sign on the wrong network. */
  networkPassphrase?: string;
}

const MEMO_TEXT_MAX_BYTES = 28;

function enc(value: string): string {
  return encodeURIComponent(value);
}

export function buildSep7PayUri(params: Sep7PayParams): string {
  const { destination, amount, asset, memo, memoType = "MEMO_TEXT", message, networkPassphrase } = params;

  const isGAddress = destination.startsWith("G") && destination.length === 56;
  const isMAddress = destination.startsWith("M") && destination.length === 69; // SEP-23 muxed
  if (!isGAddress && !isMAddress) {
    throw new Error(`SEP-7: destination must be a G-address or M-address, got "${destination}"`);
  }
  if (amount !== undefined && !isValidAmount(amount)) {
    throw new Error(`SEP-7: invalid amount "${amount}"`);
  }
  if (memo !== undefined && memoType === "MEMO_TEXT") {
    const bytes = new TextEncoder().encode(memo).length;
    if (bytes > MEMO_TEXT_MAX_BYTES) {
      throw new Error(`SEP-7: MEMO_TEXT exceeds ${MEMO_TEXT_MAX_BYTES} bytes (${bytes})`);
    }
  }

  const parts: string[] = [`destination=${enc(destination)}`];

  if (amount !== undefined) parts.push(`amount=${enc(amount)}`);

  // Native asset => omit asset_code/asset_issuer. Otherwise include both.
  if (!isNative(asset)) {
    parts.push(`asset_code=${enc(asset.code)}`);
    parts.push(`asset_issuer=${enc(asset.issuer as string)}`);
  }

  if (memo !== undefined) {
    parts.push(`memo=${enc(memo)}`);
    parts.push(`memo_type=${enc(memoType)}`);
  }

  if (message !== undefined) parts.push(`msg=${enc(message)}`);
  if (networkPassphrase !== undefined) parts.push(`network_passphrase=${enc(networkPassphrase)}`);

  return `web+stellar:pay?${parts.join("&")}`;
}
