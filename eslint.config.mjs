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
]);

export default eslintConfig;
