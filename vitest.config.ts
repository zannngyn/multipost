import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

// Alias mirrors tsconfig "paths" so tests import the same specifiers as src.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    restoreMocks: true,
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
