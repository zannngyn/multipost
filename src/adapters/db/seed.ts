import { pathToFileURL } from "node:url";

import { and, eq, or, sql } from "drizzle-orm";

import { AppError } from "@/core/domain/errors";
import type { LogBindings, LogContext, Logger } from "@/core/ports/infra";

import { makeDbHandle, type Database, type DbExecutor } from "./client";
import { accounts, identities, memberships, tenants, users } from "./schema";
import {
  DEMO_TENANT_ID,
  DEMO_TENANT_NAME,
  DEMO_TENANT_SLUG,
  DEMO_USER_EMAIL,
  DEMO_USER_NAME,
  DEMO_USER_PROVIDER_ACCOUNT_ID,
  DEV_BYPASS_EMAIL,
  DEV_BYPASS_NAME,
  DEV_BYPASS_PROVIDER_ACCOUNT_ID,
} from "./seed-constants";
import { forTenant, type TenantScopedDb } from "./tenant-scope";

/**
 * Idempotent development seed: `pnpm db:seed` any number of times converges to
 * the same rows. Run it against a migrated database.
 *
 * Importing this module must stay harmless — `main()` only runs when the file
 * IS the process entrypoint. The ids live in `./seed-constants` so nothing has
 * to import this module just to know the demo tenant id.
 *
 * Logging goes through a tiny console Logger implemented here on purpose: an
 * adapter must not import another adapter (adapters/logging) — see docs/07 §2.
 */

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

type Outcome = "created" | "updated";

/** One seeded person: identity → account → membership → domain actor. */
export interface SeedOperatorResult {
  readonly email: string;
  readonly account: Outcome;
  readonly membership: Outcome;
  readonly user: Outcome;
}

export interface SeedResult {
  tenant: Outcome;
  /** The demo operator's `app_user` row. Kept for callers that predate M1.1. */
  user: Outcome;
  operators: SeedOperatorResult[];
}

interface OperatorSpec {
  readonly email: string;
  readonly name: string;
  /** Placeholder — see the comment on the constants. Never a real Google `sub`. */
  readonly providerAccountId: string;
  readonly role: "owner" | "admin" | "editor" | "viewer";
}

/**
 * Both seeded logins are owners of the demo tenant. `dev@localhost` is here
 * because the dev bypass mints a session for it and, from M1.2, a session with
 * no membership can do nothing at all (docs/08 debt B-8).
 */
const OPERATORS: readonly OperatorSpec[] = [
  {
    email: DEMO_USER_EMAIL,
    name: DEMO_USER_NAME,
    providerAccountId: DEMO_USER_PROVIDER_ACCOUNT_ID,
    role: "owner",
  },
  {
    email: DEV_BYPASS_EMAIL,
    name: DEV_BYPASS_NAME,
    providerAccountId: DEV_BYPASS_PROVIDER_ACCOUNT_ID,
    role: "owner",
  },
];

/**
 * Upserts account + identity + membership + `app_user` for one person, keeping
 * the invariant "one active membership ↔ one app_user" (docs/09 §3.2) true at
 * every commit — everything here runs inside the caller's transaction.
 *
 * `account` and `identity` are read with the raw executor and not through
 * `txScope`: they are the two tables that sit ABOVE the tenant boundary and have
 * no `tenant_id` to filter on. Membership is what ties the person to a tenant,
 * and that query IS scoped.
 */
async function seedOperator(
  tx: DbExecutor,
  txScope: TenantScopedDb<DbExecutor>,
  spec: OperatorSpec,
  log: Logger,
): Promise<SeedOperatorResult> {
  const sessionEmail = spec.email.toLowerCase();

  // Match on either key: the address (what a JWT carries) or the provider id.
  // Re-seeding a database whose identities came from the M1.1 backfill must
  // reuse them rather than fight the two unique indexes.
  const existingIdentity = await tx
    .select({ accountId: identities.accountId })
    .from(identities)
    .where(
      or(
        eq(identities.sessionEmail, sessionEmail),
        and(
          eq(identities.provider, "google"),
          eq(identities.providerAccountId, spec.providerAccountId),
        ),
      ),
    )
    .limit(1);

  let accountId = existingIdentity[0]?.accountId;
  const accountOutcome: Outcome = accountId ? "updated" : "created";

  if (accountId) {
    await tx
      .update(accounts)
      .set({ displayName: spec.name, status: "active" })
      .where(eq(accounts.id, accountId));
  } else {
    const inserted = await tx
      .insert(accounts)
      .values({ displayName: spec.name, status: "active" })
      .returning({ id: accounts.id });
    const created = inserted[0];
    if (!created) {
      // Cannot happen with RETURNING on a successful insert; if it ever does,
      // failing here beats writing an identity with a dangling account id.
      throw new AppError("DB_ERROR", {
        message: "Seed account insert returned no row",
        userMessage: "Không tạo được tài khoản mẫu.",
        context: { session_email: sessionEmail },
      });
    }
    accountId = created.id;
    await tx.insert(identities).values({
      accountId,
      provider: "google",
      providerAccountId: spec.providerAccountId,
      sessionEmail,
      email: sessionEmail,
    });
  }

  const existingMembership = await tx
    .select({ id: memberships.id, role: memberships.role, status: memberships.status })
    .from(memberships)
    .where(txScope.where(memberships, eq(memberships.accountId, accountId)))
    .limit(1);

  const current = existingMembership[0];
  const membershipOutcome: Outcome = current ? "updated" : "created";

  if (!current) {
    await tx.insert(memberships).values(txScope.row({ accountId, role: spec.role }));
  } else if (current.role !== spec.role || current.status !== "active") {
    // A role change must bump `version` — that is what invalidates the cached
    // authorization in the OTHER process (docs/09 §3.4). An unchanged re-seed
    // must NOT bump it, or every seed run would flush every cache for nothing.
    await tx
      .update(memberships)
      .set({ role: spec.role, status: "active", version: sql`${memberships.version} + 1` })
      .where(txScope.where(memberships, eq(memberships.id, current.id)));
  }

  const existingUser = await tx
    .select({ id: users.id })
    .from(users)
    .where(txScope.where(users, eq(users.email, sessionEmail)))
    .limit(1);

  const userOutcome: Outcome = existingUser[0] ? "updated" : "created";

  if (existingUser[0]) {
    await tx
      .update(users)
      .set({ name: spec.name, role: spec.role, accountId })
      .where(txScope.where(users, eq(users.id, existingUser[0].id)));
  } else {
    await tx
      .insert(users)
      // scope.row stamps tenant_id — an insert cannot forget it.
      .values(txScope.row({ email: sessionEmail, name: spec.name, role: spec.role, accountId }));
  }

  log.info("Seed: operator converged", {
    email: sessionEmail,
    account: accountOutcome,
    membership: membershipOutcome,
    user: userOutcome,
  });

  return {
    email: sessionEmail,
    account: accountOutcome,
    membership: membershipOutcome,
    user: userOutcome,
  };
}

export async function seed(db: Database, logger: Logger): Promise<SeedResult> {
  const log = logger.child({ tenant_id: DEMO_TENANT_ID });
  const scope = forTenant(db, DEMO_TENANT_ID);

  try {
    return await db.transaction(async (tx) => {
      const txScope = forTenant(tx, scope.tenantId);

      const existingTenant = await tx
        .select({ id: tenants.id, slug: tenants.slug })
        .from(tenants)
        .where(txScope.whereSelf())
        .limit(1);

      // The slug is globally unique: if another tenant already answers to
      // `demo`, leave ours null rather than fail the whole seed on a name.
      const slugTaken = await tx
        .select({ id: tenants.id })
        .from(tenants)
        .where(eq(tenants.slug, DEMO_TENANT_SLUG))
        .limit(1);
      const slugFree = !slugTaken[0] || slugTaken[0].id === DEMO_TENANT_ID;
      const slug = slugFree ? DEMO_TENANT_SLUG : (existingTenant[0]?.slug ?? null);

      if (!slugFree) {
        log.warn("Seed: demo slug is taken by another tenant, leaving it unchanged", {
          slug: DEMO_TENANT_SLUG,
        });
      }

      const tenantOutcome: Outcome = existingTenant.length === 0 ? "created" : "updated";

      if (existingTenant.length === 0) {
        await tx.insert(tenants).values({
          id: DEMO_TENANT_ID,
          name: DEMO_TENANT_NAME,
          status: "active",
          slug,
          // MYSP's own tenant: no AI spend ceiling (doc 10 §8.9).
          plan: "internal",
        });
        log.info("Seed: demo tenant created", { name: DEMO_TENANT_NAME, plan: "internal" });
      } else {
        await tx
          .update(tenants)
          .set({ name: DEMO_TENANT_NAME, status: "active", slug, plan: "internal" })
          .where(txScope.whereSelf());
        log.info("Seed: demo tenant already exists, refreshed", {
          name: DEMO_TENANT_NAME,
          plan: "internal",
        });
      }

      const operators: SeedOperatorResult[] = [];
      for (const spec of OPERATORS) {
        // Sequential on purpose: two operators racing on `identity`'s unique
        // indexes inside one transaction buys nothing and hides conflicts.
        operators.push(await seedOperator(tx, txScope, spec, log));
      }

      const demo = operators.find((operator) => operator.email === DEMO_USER_EMAIL);

      return { tenant: tenantOutcome, user: demo?.user ?? "updated", operators };
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
    logger.info("Seed finished", {
      tenant: result.tenant,
      user: result.user,
      operators: result.operators.map((operator) => operator.email).join(","),
    });
  } finally {
    await handle.close();
  }
}

/**
 * True only when this file was started directly (`pnpm db:seed`). Importing the
 * module — for `seed()` or, historically, for an id — must never write rows.
 */
function isEntrypoint(): boolean {
  // No argv[1] at all (REPL, `node -e`) means "not the entrypoint".
  const argv1 = process.argv[1];
  if (typeof argv1 !== "string" || argv1.length === 0) return false;
  return import.meta.url === pathToFileURL(argv1).href;
}

// Executed by `pnpm db:seed`. Any failure exits non-zero with a structured log.
if (isEntrypoint()) {
  main().catch((error: unknown) => {
    const wrapped = AppError.from(error, "INTERNAL", { operation: "seed" });
    console.error(
      JSON.stringify({ level: "fatal", message: "Seed crashed", err: wrapped.toLogObject() }),
    );
    process.exitCode = 1;
  });
}
