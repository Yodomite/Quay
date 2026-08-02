import { describe, expect, it, vi } from "vitest";
import { normalizePayment, type OperationWithTransaction } from "../src/normalize";

function paymentRecord(overrides: Partial<Record<string, unknown>> = {}): any {
  return {
    type: "payment",
    transaction_hash: "txhash1",
    paging_token: "12345",
    created_at: "2026-01-01T00:00:00Z",
    to: "GTO",
    from: "GFROM",
    amount: "10.5000000",
    asset_type: "credit_alphanum4",
    asset_code: "USDC",
    asset_issuer: "GISSUER",
    transaction: vi.fn(),
    ...overrides,
  };
}

describe("normalizePayment", () => {
  it("returns null for non-value operations", async () => {
    const record = paymentRecord({ type: "create_account" });
    expect(await normalizePayment(record)).toBeNull();
  });

  it("pulls the memo from the resolved transaction", async () => {
    const record = paymentRecord();
    const fetchTransaction = vi.fn(async () => ({ memo: "pl_abc123", memo_type: "text" }) as any);

    const result = await normalizePayment(record, fetchTransaction);

    expect(result).toMatchObject({
      txHash: "txhash1",
      pagingToken: "12345",
      from: "GFROM",
      to: "GTO",
      amount: "10.5000000",
      memo: "pl_abc123",
      memoType: "text",
    });
    expect(fetchTransaction).toHaveBeenCalledWith(record);
  });

  it("normalizes memo_type 'none' to a null memo", async () => {
    const record = paymentRecord();
    const fetchTransaction = vi.fn(async () => ({ memo: undefined, memo_type: "none" }) as any);

    const result = await normalizePayment(record, fetchTransaction);
    expect(result?.memo).toBeNull();
    expect(result?.memoType).toBe("none");
  });

  it("REGRESSION: a transient transaction-fetch failure propagates — it must never be downgraded to a no_memo payment", async () => {
    const record = paymentRecord();
    const fetchTransaction = vi.fn(async () => {
      throw new Error("Horizon 503");
    });

    await expect(normalizePayment(record, fetchTransaction)).rejects.toThrow("Horizon 503");
  });

  it("defaults to calling record.transaction() when no fetchTransaction is injected", async () => {
    const transaction = vi.fn(async () => ({ memo: "m", memo_type: "text" }) as any);
    const record = paymentRecord({ transaction });

    const result = await normalizePayment(record);
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(result?.memo).toBe("m");
  });
});

describe("OperationWithTransaction shape", () => {
  it("is what horizon-watcher's memoized fetchTransaction keys off of", () => {
    const record: OperationWithTransaction = { transaction_hash: "h", transaction: vi.fn() };
    expect(record.transaction_hash).toBe("h");
  });
});
