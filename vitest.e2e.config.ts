import { defineConfig } from "vitest/config";

/**
 * E2E config: runs the live-server integration suite against an already-running
 * stack (see test/e2e/app.e2e.test.ts). Kept separate from the unit config so
 * `npm test` stays hermetic.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["test/e2e/**/*.e2e.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Sequential: tests share server state (active-chat pointer per user).
    fileParallelism: false,
  },
});
