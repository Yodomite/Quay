import { describe, expect, it } from "vitest";
import { normalizePayment } from "../src/normalize";

const DEST = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

function record(over: Record<string, unknown> = {}) {
  return {
    type: "payment",
    paging_token: "1",
    transaction_hash: "tx1",
    created_at: "2026-01-01T00:00:00Z",
    to: DEST,
    from: "GBUYER",
    amount: "10",
    asset_type: "native",
    transaction: async () => ({ memo_type: "none", memo: undefined }),
    ...over,
  };
}

describe("normalizePayment", () => {
  it("sets toMuxedId to null for an ordinary G-address payment", async () => {
    const payment = await normalizePayment(record() as any);
    expect(payment?.toMuxedId).toBeNull();
  });

  it("decodes to_muxed_id when the payer sent to an M-address", async () => {
    const payment = await normalizePayment(record({ to_muxed_id: "123456789" }) as any);
    expect(payment?.toMuxedId).toBe("123456789");
    // `to` still resolves to the underlying G-address regardless of muxing.
    expect(payment?.to).toBe(DEST);
  });

  it("returns null for non-value operations regardless of muxing", async () => {
    const payment = await normalizePayment(record({ type: "create_account", to_muxed_id: "1" }) as any);
    expect(payment).toBeNull();
  });
});
