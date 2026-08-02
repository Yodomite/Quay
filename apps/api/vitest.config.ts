import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    // The off-ramp poll-backoff tests wait on a real 2s backoff; 5s is too
    // tight under parallel load.
    testTimeout: 10_000,
    hookTimeout: 10_000,
  },
});
