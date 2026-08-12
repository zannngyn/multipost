import { eq } from "drizzle-orm";

import { AppError } from "@/core/domain/errors";
import type { LogBindings, LogContext, Logger } from "@/core/ports/infra";

import { makeDbHandle, type Database } from "./client";
import { tenants, users } from "./schema";
import { forTenant } from "./tenant-scope";

/**
 * Idempotent development seed: `pnpm db:seed` any number of times converges to
 * the same rows. Run it against a migrated database.
 *
 * Logging goes through a tiny console Logger implemented here on purpose: an
 * adapter must not import another adapter (adapters/logging) — see docs/07 §2.
 */

/** Fixed id so fixtures, tests and manual API calls can hard-code one tenant. */
export const DEMO_TENANT_ID = "00000000-0000-0000-0000-000000000001";
const DEMO_TENANT_NAME = "Demo Tenant";
const DEMO_USER_EMAIL = "demo@mysp.local";
const DEMO_USER_NAME = "Demo Operator";

function makeConsoleLogger(bindings: LogBindings = {}): Logger {
  const write = (level: string, message: string, context?: LogContext) => {
    const line = { level, time: new Date().toISOString(), ...bindings, ...context, message };
    // Seed is a CLI script: stdout IS its log channel.
    console.log(JSON.stringify(line));
  };
  return {
    child: (extra) => makeConsoleLogger({ ...bindings, ...extra }),
    debug: (message, context) => write("debug", message, context),
    info: (message, context) => write("info", message, context),
    warn: (message, context) => write("warn", message, context),
    error: (message, context) => {
      const { err, ...rest } = context ?? {};
      const serialised = AppError.is(err)
        ? err.toLogObject()
        : err instanceof Error
          ? { message: err.message, stack: err.stack }
          : err === undefined
            ? undefined
            : { message: String(err) };
      write("error", message, { ...rest, err: serialised });
    },
  };
}

export interface SeedResult {
  tenant: "created" | "updated";
  user: "created" | "updated";
}

export async function seed(db: Database, logger: Logger): Promise<SeedResult> {
  const log = logger.child({ tenant_id: DEMO_TENANT_ID });
  const scope = forTenant(db, DEMO_TENANT_ID);

  try {
    return await db.transaction(async (tx) => {
      const txScope = forTenant(tx, scope.tenantId);

      const existingTenant = await tx
        .select({ id: tenants.id })
        .from(tenants)
        .where(txScope.whereSelf())
        .limit(1);

      if (existingTenant.length === 0) {
        await tx
          .insert(tenants)
          .values({ id: DEMO_TENANT_ID, name: DEMO_TENANT_NAME, status: "active" });
        log.info("Seed: demo tenant created", { name: DEMO_TENANT_NAME });
      } else {
        await tx
          .update(tenants)
          .set({ name: DEMO_TENANT_NAME, status: "active" })
          .where(txScope.whereSelf());
        log.info("Seed: demo tenant already exists, refreshed", { name: DEMO_TENANT_NAME });
      }

      const existingUser = await tx
        .select({ id: users.id })
        .from(users)
        .where(txScope.where(users, eq(users.email, DEMO_USER_EMAIL)))
        .limit(1);

      if (existingUser.length === 0) {
        await tx.insert(users).values(
          // scope.row stamps tenant_id — an insert cannot forget it.
          txScope.row({ email: DEMO_USER_EMAIL, name: DEMO_USER_NAME, role: "owner" as const }),
        );
        log.info("Seed: demo user created", { email: DEMO_USER_EMAIL });
        return { tenant: existingTenant.length === 0 ? "created" : "updated", user: "created" };
      }

      await tx
        .update(users)
        .set({ name: DEMO_USER_NAME, role: "owner" })
        .where(txScope.where(users, eq(users.email, DEMO_USER_EMAIL)));
      log.info("Seed: demo user already exists, refreshed", { email: DEMO_USER_EMAIL });
      return { tenant: existingTenant.length === 0 ? "created" : "updated", user: "updated" };
    });
  } catch (error) {
    const wrapped = AppError.from(error, "DB_ERROR", {
      tenant_id: DEMO_TENANT_ID,
      operation: "seed",
    });
    log.error("Seed failed", { err: wrapped, error_code: wrapped.code });
    throw wrapped;
  }
}

async function main(): Promise<void> {
  const logger = makeConsoleLogger({ service: "mysp-seed" });
  const url = process.env.DATABASE_URL;

  if (!url) {
    // Fail fast and loudly: a seed against the wrong/absent DB is worse than none.
    const error = new AppError("INVALID_INPUT", {
      message: "DATABASE_URL is not set",
      userMessage: "Thiếu biến môi trường DATABASE_URL.",
    });
    logger.error("Seed aborted", { err: error, error_code: error.code });
    throw error;
  }

  const handle = makeDbHandle({ url, maxPoolSize: 1 });
  try {
    const result = await seed(handle.db, logger);
    logger.info("Seed finished", { ...result });
  } finally {
    await handle.close();
  }
}

// Executed by `pnpm db:seed`. Any failure exits non-zero with a structured log.
main().catch((error: unknown) => {
  const wrapped = AppError.from(error, "INTERNAL", { operation: "seed" });
  console.error(JSON.stringify({ level: "fatal", message: "Seed crashed", err: wrapped.toLogObject() }));
  process.exitCode = 1;
});
