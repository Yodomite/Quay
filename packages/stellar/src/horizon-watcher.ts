import type { NormalizedPayment, WatcherPort } from "@checkout/core";
import { normalizePayment } from "./normalize";
import { type HorizonClient, isNotFound, realHorizonClient } from "./horizon-client";

/**
 * Polling implementation of WatcherPort over Horizon.
 *
 * Polling (vs streaming) is deliberate for the MVP: it is restart-safe with a
 * persisted cursor and trivial to reason about. `StreamingHorizonWatcher`
 * satisfies the same interface for the WATCH_MODE=stream path.
 */
export class HorizonWatcher implements WatcherPort {
  private readonly client: HorizonClient;

  constructor(horizonUrlOrClient: string | HorizonClient) {
    this.client =
      typeof horizonUrlOrClient === "string" ? realHorizonClient(horizonUrlOrClient) : horizonUrlOrClient;
  }

  /** Newest payment paging-token for an account, used to seed a fresh watch. */
  async latestCursor(account: string): Promise<string | null> {
    try {
      const page = await this.client
        .payments()
        .forAccount(account)
        .order("desc")
        .limit(1)
        .call();
      const rec = page.records[0];
      return rec ? rec.paging_token : null;
    } catch (err) {
      if (isNotFound(err)) return null; // account not yet created on-chain
      throw err;
    }
  }

  /** Value payments on this account after `cursor`, oldest-first.
   *  Includes both directions; the matcher gates correctness on destination,
   *  and the worker advances the cursor by the last token returned here. */
  async fetchSince(account: string, cursor: string, limit = 200): Promise<NormalizedPayment[]> {
    let builder = this.client.payments().forAccount(account).order("asc").limit(limit);
    if (cursor) builder = builder.cursor(cursor);

    let page;
    try {
      page = await builder.call();
    } catch (err) {
      if (isNotFound(err)) return [];
      throw err;
    }

    const out: NormalizedPayment[] = [];
    for (const record of page.records) {
      const normalized = await normalizePayment(record);
      if (normalized) out.push(normalized);
    }
    return out;
  }
}
