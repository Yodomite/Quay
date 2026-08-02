import { Horizon, encodeMuxedAccount, encodeMuxedAccountToAddress, StrKey } from "@stellar/stellar-sdk";
import type { AssetRef, PaymentRequest, RailPort } from "@checkout/core";
import { buildSep7PayUri, CannotReceiveError, isNative } from "@checkout/core";
import type { StellarConfig } from "./asset";
import { buildChangeTrustUri } from "./trustline-uri";
import { checkBalance, findAssetBalance, messageFor } from "./trustline-check";

interface CacheEntry {
  expiresAt: number;
  error: CannotReceiveError | null; // null = "can receive", cached as a pass
}

const PREFLIGHT_CACHE_TTL_MS = 60_000;

/** SEP-23: wraps a G-address and a 64-bit id into an M-address. The id is
 *  carried inside the destination itself, so it survives wallets that drop,
 *  mangle, or overwrite the memo — unlike MEMO_TEXT correlation. */
export function muxedFor(account: string, id: string): string {
  if (!StrKey.isValidEd25519PublicKey(account)) {
    throw new Error(`muxedFor: account must be a G-address, got "${account}"`);
  }
  return encodeMuxedAccountToAddress(encodeMuxedAccount(account, id));
}

/** Non-custodial settlement rail: the payer pays the seller's wallet directly.
 *
 *  Two correlation modes, chosen per-link by whether `muxedId` is supplied:
 *  - memo (default): the link reference is carried as MEMO_TEXT.
 *  - muxed: the link's 64-bit id is encoded into an SEP-23 M-address and no
 *    memo is set. Memo-mode requests are built exactly as before either way —
 *    the muxed path is additive, not a refactor of the existing one. */
export class StellarRail implements RailPort {
  private readonly server: Horizon.Server;
  private readonly preflightCache = new Map<string, CacheEntry>();

  constructor(private readonly cfg: StellarConfig) {
    this.server = new Horizon.Server(cfg.horizonUrl);
  }

  buildRequest(input: {
    destination: string;
    amount: string;
    asset: AssetRef;
    reference: string;
    muxedId?: string | null;
    message?: string;
  }): PaymentRequest {
    const destination = input.muxedId ? muxedFor(input.destination, input.muxedId) : input.destination;
    const memo = input.muxedId ? undefined : input.reference;

    const uri = buildSep7PayUri({
      destination,
      amount: input.amount,
      asset: input.asset,
      memo,
      memoType: memo !== undefined ? "MEMO_TEXT" : undefined,
      message: input.message,
      networkPassphrase: this.cfg.networkPassphrase,
    });
    return {
      uri,
      destination,
      amount: input.amount,
      asset: input.asset,
      memo: memo ?? null,
    };
  }

  isValidDestination(address: string): boolean {
    return StrKey.isValidEd25519PublicKey(address);
  }

  async assertCanReceive(account: string, asset: AssetRef): Promise<void> {
    const cacheKey = `${account}:${asset.code}:${asset.issuer ?? "native"}`;
    const cached = this.preflightCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      if (cached.error) throw cached.error;
      return;
    }

    try {
      await this.checkCanReceive(account, asset);
      this.preflightCache.set(cacheKey, { expiresAt: Date.now() + PREFLIGHT_CACHE_TTL_MS, error: null });
    } catch (err) {
      if (err instanceof CannotReceiveError) {
        this.preflightCache.set(cacheKey, { expiresAt: Date.now() + PREFLIGHT_CACHE_TTL_MS, error: err });
      }
      throw err;
    }
  }

  private async checkCanReceive(account: string, asset: AssetRef): Promise<void> {
    // Typed from loadAccount's own return, not a guessed SDK type-export path —
    // the exact Horizon.* namespace for this has moved between SDK versions.
    let horizonAccount: Awaited<ReturnType<Horizon.Server["loadAccount"]>>;
    try {
      horizonAccount = await this.server.loadAccount(account);
    } catch (err) {
      if (isNotFound(err)) {
        throw new CannotReceiveError("account_not_found", messageFor("account_not_found", account, asset));
      }
      throw err;
    }

    // Native XLM needs no trustline; the account already existing (above) is the whole check.
    if (isNative(asset)) return;

    const balance = findAssetBalance(horizonAccount.balances, asset);
    const reason = checkBalance(balance, asset);
    if (reason === null) return;

    const trustlineUri = reason === "no_trustline" ? buildChangeTrustUri(horizonAccount, asset, this.cfg.networkPassphrase) : undefined;
    throw new CannotReceiveError(reason, messageFor(reason, account, asset, balance), trustlineUri);
  }
}

function isNotFound(err: unknown): boolean {
  const e = err as { response?: { status?: number }; name?: string };
  return e?.response?.status === 404 || e?.name === "NotFoundError";
}
