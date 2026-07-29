import { describe, expect, it } from "vitest";
import { StreamingHorizonWatcher } from "../src/streaming-horizon-watcher";
import { FakeHorizonClient } from "./fake-horizon";
import { runWatcherContract } from "./watcher-contract";

const FAST_BACKOFF = { initialBackoffMs: 5, maxBackoffMs: 20 };

runWatcherContract("StreamingHorizonWatcher (stream)", () => {
  const fake = new FakeHorizonClient();
  const watcher = new StreamingHorizonWatcher(fake, FAST_BACKOFF);
  return { fake, watcher, killConnection: (account) => fake.killConnection(account) };
});

describe("StreamingHorizonWatcher extras", () => {
  const ACCOUNT = "GDEST0000000000000000000000000000000000000000000000000000";

  it("reconnects after a dropped connection and re-subscribes", async () => {
    const fake = new FakeHorizonClient();
    const watcher = new StreamingHorizonWatcher(fake, FAST_BACKOFF);

    fake.addPayment({ account: ACCOUNT, memo: "ref_1" });
    await watcher.fetchSince(ACCOUNT, "");
    expect(fake.liveSubscriberCount(ACCOUNT)).toBe(1);

    fake.killConnection(ACCOUNT);
    expect(fake.liveSubscriberCount(ACCOUNT)).toBe(0);

    await new Promise((r) => setTimeout(r, 50));
    expect(fake.liveSubscriberCount(ACCOUNT)).toBe(1);

    watcher.stop();
  });

  it("reconciles a payment that lands entirely during the outage", async () => {
    const fake = new FakeHorizonClient();
    const watcher = new StreamingHorizonWatcher(fake, FAST_BACKOFF);

    fake.addPayment({ account: ACCOUNT, memo: "ref_1" });
    const first = await watcher.fetchSince(ACCOUNT, "");
    const cursor = first[0]!.pagingToken;

    fake.killConnection(ACCOUNT);
    // Lands while no SSE subscriber is registered — only the reconnect's
    // reconciliation poll (not the stream) can pick this one up.
    fake.addPayment({ account: ACCOUNT, memo: "ref_2" });

    await new Promise((r) => setTimeout(r, 50));
    const recovered = await watcher.fetchSince(ACCOUNT, cursor);
    expect(recovered.map((p) => p.memo)).toEqual(["ref_2"]);

    watcher.stop();
  });

  it("stop() closes every live subscription", async () => {
    const fake = new FakeHorizonClient();
    const watcher = new StreamingHorizonWatcher(fake, FAST_BACKOFF);
    fake.addPayment({ account: ACCOUNT, memo: "ref_1" });
    await watcher.fetchSince(ACCOUNT, "");
    expect(fake.liveSubscriberCount(ACCOUNT)).toBe(1);

    watcher.stop();
    expect(fake.liveSubscriberCount(ACCOUNT)).toBe(0);

    // A drop after stop() must not resurrect a reconnect loop.
    fake.killConnection(ACCOUNT);
    await new Promise((r) => setTimeout(r, 50));
    expect(fake.liveSubscriberCount(ACCOUNT)).toBe(0);
  });
});
