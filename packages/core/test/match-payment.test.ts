import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { matchPayment, type NormalizedPayment } from "../src/matching/match-payment";
import type { PaymentLink } from "../src/domain/payment-link";

// ── Shared constants ──────────────────────────────────────────────────────────

const DEST = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
const ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

function link(over: Partial<PaymentLink> = {}): PaymentLink {
  return {
    id: "lnk_1",
    reference: "ref_1",
    sellerId: "s_1",
    destination: DEST,
    muxedId: null,
    title: "Test",
    amount: "10",
    asset: { code: "USDC", issuer: ISSUER },
    status: "active",
    txHash: null,
    payer: null,
    paidAmount: null,
    offrampJobId: null,
    offrampTargetCurrency: null,
    offrampStatus: null,
    expiresAt: null,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

function payment(over: Partial<NormalizedPayment> = {}): NormalizedPayment {
  return {
    txHash: "tx1",
    pagingToken: "1",
    from: "GBUYER",
    to: DEST,
    amount: "10",
    asset: { code: "USDC", issuer: ISSUER },
    memo: "ref_1",
    memoType: "text",
    toMuxedId: null,
    createdAt: "2026-01-01T00:00:00Z",
    ...over,
  };
}

const byRef = (l: PaymentLink) => (ref: string) => (ref === l.reference ? l : undefined);
const byMuxedId = (l: PaymentLink) => (id: string) => (l.muxedId && id === l.muxedId ? l : undefined);

// ── Example-based tests ───────────────────────────────────────────────────────

describe("matchPayment", () => {
  it("marks exact payment as paid", () => {
    const l = link();
    const r = matchPayment(payment(), byRef(l));
    expect(r.kind).toBe("paid");
    if (r.kind === "paid") expect(r.overpaid).toBe(false);
  });

  it("flags overpayment as paid+overpaid", () => {
    const l = link();
    const r = matchPayment(payment({ amount: "12" }), byRef(l));
    expect(r.kind).toBe("paid");
    if (r.kind === "paid") expect(r.overpaid).toBe(true);
  });

  it("flags underpayment", () => {
    const l = link();
    const r = matchPayment(payment({ amount: "9.5" }), byRef(l));
    expect(r.kind).toBe("underpaid");
  });

  it("rejects wrong asset even if memo matches", () => {
    const l = link();
    const r = matchPayment(payment({ asset: { code: "XLM", issuer: null } }), byRef(l));
    expect(r.kind).toBe("asset_mismatch");
  });

  it("returns no_memo when memo missing", () => {
    const l = link();
    const r = matchPayment(payment({ memo: null, memoType: "none" }), byRef(l));
    expect(r.kind).toBe("no_memo");
  });

  it("returns unknown_reference for an unrecognized memo", () => {
    const l = link();
    const r = matchPayment(payment({ memo: "ref_other" }), byRef(l));
    expect(r.kind).toBe("unknown_reference");
  });

  it("rejects a payment addressed to a different destination", () => {
    const l = link();
    const r = matchPayment(payment({ to: "GSOMEONEELSE" }), byRef(l));
    expect(r.kind).toBe("unknown_reference");
  });

  describe("muxed correlation (SEP-23)", () => {
    it("matches by muxed id with no memo at all", () => {
      const l = link({ muxedId: "123456789" });
      const r = matchPayment(
        payment({ memo: null, memoType: "none", toMuxedId: "123456789" }),
        byRef(l),
        byMuxedId(l),
      );
      expect(r.kind).toBe("paid");
    });

    it("still enforces destination/asset/amount rules on the muxed path", () => {
      const l = link({ muxedId: "123456789" });
      const underpaid = matchPayment(
        payment({ memo: null, memoType: "none", toMuxedId: "123456789", amount: "1" }),
        byRef(l),
        byMuxedId(l),
      );
      expect(underpaid.kind).toBe("underpaid");

      const wrongDest = matchPayment(
        payment({ memo: null, memoType: "none", toMuxedId: "123456789", to: "GSOMEONEELSE" }),
        byRef(l),
        byMuxedId(l),
      );
      expect(wrongDest.kind).toBe("unknown_reference");
    });

    it("falls back to unknown_reference for a muxed id no link owns, even with no memo", () => {
      const l = link({ muxedId: "123456789" });
      const r = matchPayment(
        payment({ memo: null, memoType: "none", toMuxedId: "999999999" }),
        byRef(l),
        byMuxedId(l),
      );
      expect(r.kind).toBe("no_memo");
    });

    it("prefers muxed id over memo when a payment somehow carries both", () => {
      const muxedLink = link({ id: "lnk_muxed", reference: "ref_other", muxedId: "123456789" });
      const memoLink = link({ id: "lnk_memo", reference: "ref_1" });
      const finders = (candidates: PaymentLink[]) => ({
        byRef: (ref: string) => candidates.find((c) => c.reference === ref),
        byMuxed: (id: string) => candidates.find((c) => c.muxedId === id),
      });
      const f = finders([muxedLink, memoLink]);
      const r = matchPayment(payment({ toMuxedId: "123456789" }), f.byRef, f.byMuxed);
      expect(r.kind).toBe("paid");
      if (r.kind === "paid") expect(r.link.id).toBe("lnk_muxed");
    });

    it("is unaffected by an unused findLinkByMuxedId when the payment carries no muxed id", () => {
      const l = link();
      const r = matchPayment(payment(), byRef(l), () => {
        throw new Error("should not be called");
      });
      expect(r.kind).toBe("paid");
    });
  });
});

// ── Property-based tests ──────────────────────────────────────────────────────
// Run 1 000 cases per property; fast-check prints the seed on failure.

const RUNS = 1_000;

// Arbitraries ──────────────────────────────────────────────────────────────────

/** A Stellar-like public key: "G" + 55 base32 chars (A-Z, 2-7). */
const base32Char = fc.constantFrom(
  ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".split(""),
);
const stellarAddress = fc
  .array(base32Char, { minLength: 55, maxLength: 55 })
  .map((chars) => "G" + chars.join(""));

/** A short reference string (alphanumeric, hyphen, underscore), ≤28 chars. */
const refChar = fc.constantFrom(
  ..."abcdefghijklmnopqrstuvwxyz0123456789_-".split(""),
);
const referenceArb = fc
  .array(refChar, { minLength: 1, maxLength: 28 })
  .map((chars) => chars.join(""));

/** A valid Stellar amount string (0–7 decimal places, non‑negative). */
const validAmount = fc
  .record({
    whole: fc.integer({ min: 0, max: 999_999_999_999 }),
    fracDigits: fc.integer({ min: 0, max: 7 }),
    fracValue: fc.integer({ min: 0, max: 9_999_999 }),
  })
  .map(({ whole, fracDigits, fracValue }) => {
    if (fracDigits === 0) return `${whole}`;
    const maxFrac = 10 ** fracDigits - 1;
    const fv = fracValue % (maxFrac + 1);
    return `${whole}.${fv.toString().padStart(fracDigits, "0")}`;
  });

/** A payment generated from a link that shares the same destination, amount, asset, and memo. */
function exactPaymentFor(
  l: PaymentLink,
  pagingToken: string,
  txHash: string,
  from: string,
): NormalizedPayment {
  return {
    txHash,
    pagingToken,
    from,
    to: l.destination,
    amount: l.amount,
    asset: l.asset,
    memo: l.reference,
    memoType: "text",
    toMuxedId: null,
    createdAt: "2026-01-01T00:00:00Z",
  };
}

// ── Properties ────────────────────────────────────────────────────────────────

describe("property: exact payment is always paid", () => {
  it("a payment that exactly matches the link is 'paid' and not overpaid", () => {
    fc.assert(
      fc.property(
        stellarAddress,
        stellarAddress,
        validAmount,
        referenceArb,
        stellarAddress,
        (dest, sellerId, amount, ref, from) => {
          const lnk: PaymentLink = {
            id: "lnk_prop",
            reference: ref,
            sellerId,
            destination: dest,
            muxedId: null,
            title: "Property test",
            amount,
            asset: { code: "USDC", issuer: ISSUER },
            status: "active",
            txHash: null,
            payer: null,
            paidAmount: null,
            offrampJobId: null,
            offrampTargetCurrency: null,
            offrampStatus: null,
            expiresAt: null,
            createdAt: 0,
            updatedAt: 0,
          };

          const pay = exactPaymentFor(lnk, "1", "tx1", from);
          const lookup = (r: string) => (r === lnk.reference ? lnk : undefined);

          const r = matchPayment(pay, lookup);
          expect(r.kind).toBe("paid");
          if (r.kind === "paid") expect(r.overpaid).toBe(false);
        },
      ),
      { numRuns: RUNS },
    );
  });
});

describe("property: destination mismatch is never paid", () => {
  it("a payment addressed to a different destination returns unknown_reference", () => {
    fc.assert(
      fc.property(
        stellarAddress,
        stellarAddress,
        validAmount,
        referenceArb,
        stellarAddress,
        (linkDest, sellerId, amount, ref, paymentDest) => {
          fc.pre(linkDest !== paymentDest);

          const lnk: PaymentLink = {
            id: "lnk_prop",
            reference: ref,
            sellerId,
            destination: linkDest,
            muxedId: null,
            title: "Property test",
            amount,
            asset: { code: "USDC", issuer: ISSUER },
            status: "active",
            txHash: null,
            payer: null,
            paidAmount: null,
            offrampJobId: null,
            offrampTargetCurrency: null,
            offrampStatus: null,
            expiresAt: null,
            createdAt: 0,
            updatedAt: 0,
          };

          const pay: NormalizedPayment = {
            txHash: "tx1",
            pagingToken: "1",
            from: "GBUYER",
            to: paymentDest,
            amount,
            asset: { code: "USDC", issuer: ISSUER },
            memo: ref,
            memoType: "text",
            toMuxedId: null,
            createdAt: "2026-01-01T00:00:00Z",
          };

          const lookup = (r: string) => (r === lnk.reference ? lnk : undefined);

          expect(matchPayment(pay, lookup).kind).toBe("unknown_reference");
        },
      ),
      { numRuns: RUNS },
    );
  });
});

describe("property: memo whitespace is not trimmed", () => {
  it("whitespace-padded memo does NOT match the link (explicit behaviour)", () => {
    fc.assert(
      fc.property(
        stellarAddress,
        validAmount,
        referenceArb,
        fc.array(fc.constantFrom(" ", "\t"), { minLength: 1, maxLength: 3 }),
        fc.oneof(
          fc.constant("leading" as const),
          fc.constant("trailing" as const),
          fc.constant("both" as const),
        ),
        (dest, amount, ref, whitespaceArr, mode) => {
          const whitespace = whitespaceArr.join("");
          const lnk: PaymentLink = {
            id: "lnk_prop",
            reference: ref,
            sellerId: "s_prop",
            destination: dest,
            muxedId: null,
            title: "Property test",
            amount,
            asset: { code: "USDC", issuer: ISSUER },
            status: "active",
            txHash: null,
            payer: null,
            paidAmount: null,
            offrampJobId: null,
            offrampTargetCurrency: null,
            offrampStatus: null,
            expiresAt: null,
            createdAt: 0,
            updatedAt: 0,
          };

          // Pad the memo with whitespace according to the randomly chosen mode.
          const paddedMemo =
            mode === "leading"
              ? whitespace + ref
              : mode === "trailing"
                ? ref + whitespace
                : whitespace + ref + whitespace;

          const pay: NormalizedPayment = {
            txHash: "tx1",
            pagingToken: "1",
            from: "GBUYER",
            to: dest,
            amount,
            asset: { code: "USDC", issuer: ISSUER },
            memo: paddedMemo,
            memoType: "text",
            toMuxedId: null,
            createdAt: "2026-01-01T00:00:00Z",
          };

          const lookup = (r: string) => (r === lnk.reference ? lnk : undefined);

          // Assert the chosen behaviour: matchPayment does NOT trim memos,
          // so a whitespace‑padded memo (leading, trailing, or both) won't
          // find the link.
          expect(matchPayment(pay, lookup).kind).toBe("unknown_reference");
        },
      ),
      { numRuns: RUNS },
    );
  });
});
