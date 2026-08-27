import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

/**
 * Suites that need real infrastructure (Postgres, Redis, MinIO).
 *
 * They live next to their unit siblings in `__tests__/` and are told apart by
 * the `.integration.test.ts` suffix, not by folder. They are kept OUT of
 * `pnpm test` on purpose: every one of them self-skips when its `TEST_*` env
 * var is unset, and a skipped suite in the default run reads as a passing one.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.integration.test.{ts,tsx}"],
    restoreMocks: true,
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
