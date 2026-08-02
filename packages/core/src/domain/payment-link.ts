import type { LinkStatus } from "./status";

/** A reference to a Stellar asset. `null` issuer means native XLM. */
export interface AssetRef {
  code: string; // "USDC" or "XLM"
  issuer: string | null; // G... issuer, or null for native
}

export const XLM: AssetRef = { code: "XLM", issuer: null };

export function isNative(asset: AssetRef): boolean {
  return asset.issuer === null;
}

export function assetEquals(a: AssetRef, b: AssetRef): boolean {
  if (isNative(a) || isNative(b)) {
    return isNative(a) && isNative(b) && a.code === b.code;
  }
  return a.code === b.code && a.issuer === b.issuer;
}

export interface PaymentLink {
  id: string; // public id, used in the checkout URL (/pay/:id)
  reference: string; // short, <=28 bytes — embedded as the Stellar MEMO_TEXT
  sellerId: string;
  destination: string; // seller's G-address (payments land here, non-custodial)
  // SEP-23 muxed id embedded in the M-address handed to the payer when
  // CORRELATION=muxed. Null in memo mode (the default) — the two correlation
  // paths are independent, and a link only ever uses one.
  muxedId: string | null;
  title: string;
  amount: string; // requested amount, canonical decimal string
  asset: AssetRef;
  status: LinkStatus;
  // settlement (filled when paid)
  txHash: string | null;
  payer: string | null;
  paidAmount: string | null;
  // off-ramp (filled when the seller cashes out)
  offrampJobId: string | null;
  offrampTargetCurrency: string | null;
  offrampStatus: string | null;
  expiresAt: number | null; // epoch ms
  createdAt: number;
  updatedAt: number;
}
