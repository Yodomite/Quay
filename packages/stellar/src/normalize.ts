import type { Horizon } from "@stellar/stellar-sdk";
import type { AssetRef, NormalizedPayment } from "@checkout/core";

// Operation types that move value to a recipient and carry a destination asset/amount.
const VALUE_TYPES = new Set([
  "payment",
  "path_payment_strict_receive",
  "path_payment_strict_send",
]);

type AnyRecord = Horizon.ServerApi.PaymentOperationRecord | Horizon.ServerApi.OperationRecord;

interface ValueFields {
  to?: string;
  from?: string;
  amount?: string;
  asset_type?: string;
  asset_code?: string;
  asset_issuer?: string;
  // Present when the operation's destination was specified as an SEP-23
  // M-address; Horizon still normalizes `to` to the underlying G-address.
  to_muxed_id?: string;
}

export type OperationWithTransaction = { transaction_hash: string; transaction: () => Promise<Horizon.ServerApi.TransactionRecord> };

/** Resolves an operation record's parent transaction. Injected so the watcher
 *  can supply a per-tick memoized/batched implementation (see horizon-watcher.ts)
 *  instead of every record hitting Horizon independently. */
export type FetchTransaction = (record: OperationWithTransaction) => Promise<Horizon.ServerApi.TransactionRecord>;

const defaultFetchTransaction: FetchTransaction = (record) => record.transaction();

export function isValuePayment(record: AnyRecord): boolean {
  return VALUE_TYPES.has(record.type);
}

function assetOf(r: ValueFields): AssetRef {
  if (r.asset_type === "native" || r.asset_type === undefined) {
    return { code: "XLM", issuer: null };
  }
  return { code: r.asset_code ?? "", issuer: r.asset_issuer ?? null };
}

/**
 * Convert a raw Horizon record into a NormalizedPayment.
 * The memo lives on the *transaction*, not the operation, so we fetch it via
 * `fetchTransaction` — with `join=transactions` on the originating query
 * (see horizon-watcher.ts) this resolves from data already in hand, no
 * follow-up request. Returns null for non-value operations (e.g. create_account).
 *
 * A transaction-fetch failure is NOT downgraded to a `no_memo` outcome — it
 * throws, so a transient Horizon blip retries the whole tick instead of
 * silently parking a matchable payment as unmatched.
 */
export async function normalizePayment(
  record: AnyRecord,
  fetchTransaction: FetchTransaction = defaultFetchTransaction,
): Promise<NormalizedPayment | null> {
  if (!isValuePayment(record)) return null;
  const r = record as unknown as ValueFields &
    OperationWithTransaction & {
      paging_token: string;
      created_at: string;
    };

  const tx = await fetchTransaction(r);
  const memoType = tx.memo_type ?? null;
  const memo = memoType && memoType !== "none" ? (tx.memo ?? null) : null;

  return {
    txHash: r.transaction_hash,
    pagingToken: r.paging_token,
    from: r.from ?? "",
    to: r.to ?? "",
    amount: r.amount ?? "0",
    asset: assetOf(r),
    memo,
    memoType,
    toMuxedId: r.to_muxed_id ?? null,
    createdAt: r.created_at,
  };
}
