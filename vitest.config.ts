import { fileURLToPath } from "node:url";

import { configDefaults, defineConfig } from "vitest/config";

// Alias mirrors tsconfig "paths" so tests import the same specifiers as src.
//
// `include` deliberately stays broad rather than narrowing to `__tests__/`:
// a test placed outside the convention must still RUN (and get caught in
// review), never be silently skipped by the glob.
//
// Integration suites are excluded — they need Postgres/Redis/MinIO and self-skip
// without them, so keeping them here would report skipped suites as passing.
// Run them with `pnpm test:integration` (vitest.integration.config.ts).
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    exclude: [...configDefaults.exclude, "**/*.integration.test.{ts,tsx}"],
    restoreMocks: true,
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
