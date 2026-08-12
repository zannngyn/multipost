/**
 * Second enforcement of the one-way dependency law (docs/07 section 2 + 5).
 * ESLint catches it while typing; this catches it in CI, including transitive
 * and circular edges ESLint cannot see. Rules mirror the import matrix.
 */

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "no-circular",
      severity: "error",
      comment: "Circular imports hide ownership and break the layer direction.",
      from: {},
      to: { circular: true },
    },

    // --- core -------------------------------------------------------------
    {
      name: "core-no-outer-layer",
      severity: "error",
      comment: "core must not import adapters/composition/app/worker/ui (docs/07).",
      from: { path: "^src/core/" },
      to: { path: "^src/(adapters|composition|app|worker|ui)/" },
    },
    {
      name: "core-no-io-lib",
      severity: "error",
      comment: "core is pure TypeScript — declare needs as ports instead.",
      from: { path: "^src/core/" },
      to: {
        dependencyTypes: ["npm", "npm-dev", "npm-optional", "npm-peer", "npm-no-pkg", "core"],
        // zod is a pure schema lib (no I/O) and is allowed inside core.
        pathNot: "node_modules/(zod|@standard-schema)",
      },
    },

    // --- adapters ---------------------------------------------------------
    {
      name: "adapters-no-outer-layer",
      severity: "error",
      comment: "adapters must not import composition/app/worker/ui.",
      from: { path: "^src/adapters/" },
      to: { path: "^src/(composition|app|worker|ui)/" },
    },
    {
      name: "adapters-no-usecase",
      severity: "error",
      comment: "An adapter implements a port; it never calls a usecase back.",
      from: { path: "^src/adapters/" },
      to: { path: "^src/core/usecases/" },
    },
    {
      name: "no-cross-adapter",
      severity: "error",
      comment: "Adapters talk to each other through core ports, not directly.",
      from: { path: "^src/adapters/([^/]+)/" },
      to: { path: "^src/adapters/([^/]+)/", pathNot: "^src/adapters/$1/" },
    },

    // --- composition ------------------------------------------------------
    {
      name: "composition-no-interface-layer",
      severity: "error",
      comment: "composition is wired into app/worker/ui, never the other way.",
      from: { path: "^src/composition/" },
      to: { path: "^src/(app|worker|ui)/" },
    },

    // --- app / worker -----------------------------------------------------
    {
      name: "interface-no-adapter",
      severity: "error",
      comment: "app/worker get ready-made usecases from composition, not adapters.",
      from: { path: "^src/(app|worker)/" },
      to: { path: "^src/adapters/" },
    },
    {
      name: "interface-core-errors-only",
      severity: "error",
      comment: "app/worker may only import types + error codes from core.",
      from: { path: "^src/(app|worker)/" },
      to: { path: "^src/core/", pathNot: "^src/core/domain/errors" },
    },
    {
      name: "worker-no-ui",
      severity: "error",
      comment: "worker is a plain Node process — no UI, no Next routes.",
      from: { path: "^src/worker/" },
      to: { path: "^src/(ui|app)/" },
    },

    // --- ui ---------------------------------------------------------------
    {
      name: "ui-no-backend",
      severity: "error",
      comment: "ui only knows @/shared and @/ui; it reaches BE over HTTP.",
      from: { path: "^src/ui/" },
      to: { path: "^src/(core|adapters|composition|app|worker)/" },
    },

    // --- shared -----------------------------------------------------------
    {
      name: "shared-must-stay-pure",
      severity: "error",
      comment: "shared holds pure types/utils — it depends on no layer.",
      from: { path: "^src/shared/" },
      to: { path: "^src/(core|adapters|composition|app|worker|ui)/" },
    },
  ],

  options: {
    doNotFollow: { path: "node_modules" },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.json" },
    // Tests import vitest and cross layers on purpose; they ship nothing.
    exclude: { path: "\\.(test|spec)\\.(ts|tsx)$" },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default", "types"],
      extensions: [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"],
      mainFields: ["module", "main", "types", "typings"],
    },
    reporterOptions: {
      dot: { collapsePattern: "^src/[^/]+/[^/]+" },
    },
  },
};
