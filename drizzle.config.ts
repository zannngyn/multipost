import { defineConfig } from "drizzle-kit";

// Migrations are generated from the schema barrel and checked into ./drizzle.
// DATABASE_URL is only needed by `db:migrate`, not by `db:generate`.
const url = process.env.DATABASE_URL ?? "";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/adapters/db/schema/index.ts",
  out: "./drizzle",
  dbCredentials: { url },
  strict: true,
  verbose: true,
});
