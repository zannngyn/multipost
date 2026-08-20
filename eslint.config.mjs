import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

/**
 * Zone rules enforcing the one-way dependency law (docs/07 section 2 + 5).
 * Direction: app/worker/ui -> composition -> adapters -> core. Never backwards.
 */

/** I/O libraries and frameworks core must never know about. */
const IO_LIBS = [
  "drizzle-orm*",
  "postgres*",
  "pg",
  "googleapis*",
  "google-auth-library*",
  "@google/genai*",
  "@anthropic-ai/*",
  "openai*",
  "next",
  "next/*",
  "react",
  "react-dom",
  "react/*",
  "react-dom/*",
  "bullmq*",
  "ioredis*",
  "pino*",
  "fs",
  "node:fs",
  "node:fs/*",
  "node:http",
  "node:https",
  "node:child_process",
];

/** Server-only libraries that must never reach the browser bundle via ui/. */
const SERVER_ONLY_LIBS = [
  "drizzle-orm*",
  "postgres*",
  "pg",
  "googleapis*",
  "@google/genai*",
  "@anthropic-ai/*",
  "openai*",
  "bullmq*",
  "ioredis*",
  "pino*",
];

/** Adapter folders — used to build the "no cross-adapter import" rules. */
const ADAPTER_DIRS = ["ai", "clock", "crypto", "db", "google", "logging", "media", "meta", "queue"];

const restrict = (patterns) => ({ "no-restricted-imports": ["error", { patterns }] });

/**
 * Branded-tenant guards (M1.3a, docs/11 §5 + docs/10 §5).
 *
 * `as TenantId` is how defence layer #2 gets forged, so it is banned everywhere
 * except the blessed constructor sites + tests. `systemTenantId` is the worker's
 * unchecked constructor, so importing it is banned everywhere except the worker.
 */
const AS_TENANT_ID = {
  selector: "TSAsExpression[typeAnnotation.typeName.name='TenantId']",
  message:
    "Cấm 'as TenantId' — brand chỉ được tạo qua requireTenant/legacyTenantIdFromRequest/systemTenantId/testTenantId (docs/11 §5).",
};
const IMPORT_SYSTEM_TENANT_ID = {
  selector: "ImportDeclaration[source.value='@/composition/system-tenant-id']",
  message: "systemTenantId chỉ được import trong worker (actor=system, docs/10 §5).",
};
const IMPORT_TESTING_TENANT_ID = {
  selector: "ImportDeclaration[source.value='@/core/domain/tenant-context.testing']",
  message: "testTenantId chỉ dùng trong *.test.ts / __fixtures__ (docs/11 §3).",
};
const restrictSyntax = (selectors) => ({ "no-restricted-syntax": ["error", ...selectors] });

/** Files allowed to mint the brand with an explicit cast (the closed list). */
const TENANT_BRAND_BLESSED = [
  "src/core/domain/tenant-context.ts",
  "src/core/domain/tenant-context.testing.ts",
  "src/composition/require-tenant.ts",
  "src/composition/legacy-tenant-id.ts",
  "src/composition/system-tenant-id.ts",
  // The well-known dev/seed tenant id — a literal we own, not client input.
  "src/adapters/db/seed-constants.ts",
];

/**
 * Base rules for every adapter. Flat config REPLACES a rule's options instead of
 * merging them, so any later block targeting a sub-folder must repeat these —
 * otherwise the narrower block silently drops them.
 */
const ADAPTER_BASE_PATTERNS = [
  {
    group: ["@/composition/*", "@/app/*", "@/worker/*", "@/ui/*"],
    message: "adapters không được import lớp ngoài (không gọi ngược).",
  },
  {
    group: ["@/core/usecases/*"],
    message: "adapters không được gọi ngược lên usecase — chỉ implement port.",
  },
];

const crossAdapterZones = ADAPTER_DIRS.map((dir) => ({
  files: [`src/adapters/${dir}/**`],
  rules: restrict([
    ...ADAPTER_BASE_PATTERNS,
    {
      group: ADAPTER_DIRS.filter((other) => other !== dir).map((other) => `@/adapters/${other}/*`),
      message: `adapters/${dir} không được import adapter khác — nói chuyện qua port của core.`,
    },
  ]),
}));

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,

  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Local git worktrees carry their own .next/ — linting them OOMs eslint.
    ".claude/worktrees/**",
  ]),

  // Unused code is dead weight; `_` prefix is the explicit opt-out.
  {
    files: ["src/**/*.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
    },
  },

  // --- core: the heart. Pure TypeScript, knows nothing outside itself. ------
  {
    files: ["src/core/**"],
    rules: restrict([
      {
        group: IO_LIBS,
        message: "core không được import framework/lib I/O — khai báo nhu cầu qua port.",
      },
      {
        group: ["@/adapters/*", "@/app/*", "@/worker/*", "@/ui/*", "@/composition/*"],
        message: "core không được import lớp ngoài (không gọi ngược).",
      },
    ]),
  },

  // --- adapters: implement ports, own all I/O. -----------------------------
  // Fallback for a folder not yet listed in ADAPTER_DIRS; the per-folder blocks
  // below repeat these patterns because flat config overwrites, never merges.
  {
    files: ["src/adapters/**"],
    rules: restrict(ADAPTER_BASE_PATTERNS),
  },
  ...crossAdapterZones,

  // --- composition: the only place wiring core to adapters. ----------------
  {
    files: ["src/composition/**"],
    rules: restrict([
      {
        group: ["@/app/*", "@/worker/*", "@/ui/*"],
        message: "composition không được import interface layer.",
      },
    ]),
  },

  // --- app (route handlers + RSC): thin. Usecases come from composition. ---
  {
    files: ["src/app/**"],
    rules: restrict([
      {
        group: ["@/adapters/*"],
        message: "app không được import adapter trực tiếp — lấy usecase qua composition.",
      },
      {
        // Gitignore semantics: re-include the folder before the file.
        group: ["@/core/**", "!@/core/domain", "!@/core/domain/errors"],
        message: "app chỉ được import type + error code từ core (@/core/domain/errors).",
      },
      {
        group: ["@/worker/*"],
        message: "app không được import worker entrypoint.",
      },
    ]),
  },

  // --- worker: thin job handlers. Same rules as app, plus no UI. -----------
  {
    files: ["src/worker/**"],
    rules: restrict([
      {
        group: ["@/adapters/*"],
        message: "worker không được import adapter trực tiếp — lấy usecase qua composition.",
      },
      {
        // Gitignore semantics: re-include the folder before the file.
        group: ["@/core/**", "!@/core/domain", "!@/core/domain/errors"],
        message: "worker chỉ được import type + error code từ core (@/core/domain/errors).",
      },
      {
        group: ["@/ui/*", "@/app/*", "next", "next/*", "react", "react-dom"],
        message: "worker là process Node thuần — không import UI/Next/React.",
      },
    ]),
  },

  // --- ui: presentation only. Talks to the backend over the internal API. --
  {
    files: ["src/ui/**"],
    rules: restrict([
      {
        group: ["@/core/*", "@/adapters/*", "@/composition/*", "@/app/*", "@/worker/*"],
        message: "ui chỉ được dùng @/shared + @/ui — gọi BE qua ui/services/*.api.ts.",
      },
      {
        group: SERVER_ONLY_LIBS,
        message: "ui không được import lib phía server (rò rỉ vào bundle trình duyệt).",
      },
    ]),
  },

  // --- shared: pure types + utils, no layer, no I/O. -----------------------
  {
    files: ["src/shared/**"],
    rules: restrict([
      {
        group: [
          "@/core/*",
          "@/adapters/*",
          "@/composition/*",
          "@/app/*",
          "@/worker/*",
          "@/ui/*",
          ...SERVER_ONLY_LIBS,
        ],
        message: "shared phải thuần — không phụ thuộc lớp nào và không I/O.",
      },
    ]),
  },

  // --- Branded TenantId guards (order matters: last match wins per rule). ---
  // 1. Baseline: ban the forging cast, the system ctor import and the test ctor.
  {
    files: ["src/**/*.{ts,tsx}"],
    rules: restrictSyntax([AS_TENANT_ID, IMPORT_SYSTEM_TENANT_ID, IMPORT_TESTING_TENANT_ID]),
  },
  // 2. Worker (actor=system) may import systemTenantId; the casts stay banned.
  {
    files: ["src/worker/**"],
    rules: restrictSyntax([AS_TENANT_ID, IMPORT_TESTING_TENANT_ID]),
  },
  // 3. Blessed constructor sites may cast; still no system/test ctor imports.
  {
    files: TENANT_BRAND_BLESSED,
    rules: restrictSyntax([IMPORT_SYSTEM_TENANT_ID, IMPORT_TESTING_TENANT_ID]),
  },
  // 4. Tests + fixtures are exempt from all of the above (they brand freely and
  //    wire across layers on purpose — mirrors dependency-cruiser's test exclude).
  {
    files: ["src/**/*.test.ts", "src/**/__fixtures__/**"],
    rules: { "no-restricted-syntax": "off", "no-restricted-imports": "off" },
  },
]);

export default eslintConfig;
