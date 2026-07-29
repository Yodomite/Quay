import { HorizonWatcher } from "../src/horizon-watcher";
import { FakeHorizonClient } from "./fake-horizon";
import { runWatcherContract } from "./watcher-contract";

runWatcherContract("HorizonWatcher (poll)", () => {
  const fake = new FakeHorizonClient();
  const watcher = new HorizonWatcher(fake);
  // Polling has no persistent connection to drop; fetchSince always reads
  // straight from Horizon, so there's nothing to reconnect.
  return { fake, watcher };
});
