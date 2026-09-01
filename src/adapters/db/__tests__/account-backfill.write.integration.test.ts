import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { makeDbHandle, type Database, type DbExecutor } from "../client";
import { findPgError } from "../db-errors";
import {
  accessRequests,
  accounts,
  auditLogs,
  identities,
  memberships,
  tenants,
  users,
} from "../schema";
import { makeGlobalIdentityTestLock } from "../__fixtures__/global-identity-lock";
import type { TenantId } from "@/core/domain/tenant-context";
import { testTenantId } from "@/core/domain/tenant-context.testing";

/**
 * The M1.1 backfill (drizzle/0013) — the migration that decides who can still
 * sign in after M1.2 switches the session lookup to `identity.session_email`.
 *
 * IT RUNS THE REAL MIGRATION FILE. A hand-copied SQL string in a test proves
 * nothing about the statements that actually shipped, and this is a one-shot,
 * data-destroying-if-wrong artifact.
 *
 * Every case runs inside a transaction that is ALWAYS rolled back. The backfill
 * is set-based over whole tables, so a committed run would create accounts for
 * rows belonging to other test files (vitest runs files in parallel against this
 * same database) and leave them behind after their own cleanup. Rolling back
 * keeps this file's blast radius at zero.
 *
 *   TEST_DATABASE_URL=postgres://... pnpm vitest run src/adapters/db/account-backfill.write.integration.test.ts
 */

const url = process.env.TEST_DATABASE_URL;

const BACKFILL_SQL_PATH = fileURLToPath(
  new URL("../../../../drizzle/0013_backfill_accounts_from_access_request.sql", import.meta.url),
);

function loadBackfillStatements(): string[] {
  return readFileSync(BACKFILL_SQL_PATH, "utf8")
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

/** Thrown to unwind the transaction; never escapes `inRolledBackTx`. */
const ROLLBACK = new Error("test rollback");

async function inRolledBackTx(db: Database, body: (tx: DbExecutor) => Promise<void>): Promise<void> {
  try {
    await db.transaction(async (tx) => {
      await body(tx);
      throw ROLLBACK;
    });
  } catch (error) {
    // An assertion failure must surface; only our own sentinel is swallowed.
    if (error !== ROLLBACK) throw error;
  }
}

/**
 * Which constraint Postgres refused on. Drizzle's own message is only "Failed
 * query: insert into ..." — asserting on that would pass even if a DIFFERENT
 * index rejected the row, which is exactly the mistake these tests exist to
 * catch. The name lives on the driver error inside `cause`.
 */
async function violatedConstraint(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    const pgError = findPgError(error) as { constraint_name?: unknown } | null;
    const name = pgError?.constraint_name;
    return typeof name === "string" ? name : `no constraint name on: ${String(error)}`;
  }
  return "no error thrown";
}

describe.skipIf(!url)("M1.1 backfill — access_request/app_user -> account/identity/membership", () => {
  const handle = makeDbHandle({ url: url ?? "postgres://unused", maxPoolSize: 3 });
  const statements = loadBackfillStatements();

  // The replayed SQL scans the WHOLE access_request table; since M1.2 other
  // files write global identity rows concurrently — serialise or race (see the
  // lock's module doc).
  const globalLock = makeGlobalIdentityTestLock(url ?? "postgres://unused");
  beforeAll(() => globalLock.acquire());

  afterAll(async () => {
    await globalLock.release();
    await handle.close();
  });

  const runBackfill = async (tx: DbExecutor): Promise<void> => {
    for (const statement of statements) {
      await tx.execute(sql.raw(statement));
    }
  };

  /**
   * One fixture set covering every branch of the decision table at once: the
   * cases interact (blocked-wins is only observable next to an approval), so
   * splitting them into separate fixtures would test a world that cannot happen.
   */
  interface Fixture {
    readonly tenantA: TenantId;
    readonly tenantB: TenantId;
    readonly approvedEmail: string;
    readonly blockedEmail: string;
    readonly pendingEmail: string;
    readonly noRoleEmail: string;
    readonly duplicateEmail: string;
    readonly movedOldEmail: string;
    readonly movedNewEmail: string;
    readonly emails: string[];
  }

  const insertFixture = async (tx: DbExecutor): Promise<Fixture> => {
    const p = randomUUID().slice(0, 8);
    const tenantA = testTenantId(randomUUID());
    const tenantB = testTenantId(randomUUID());

    await tx.insert(tenants).values([
      { id: tenantA, name: `M1.1 backfill A ${p}`, status: "active" },
      { id: tenantB, name: `M1.1 backfill B ${p}`, status: "active" },
    ]);

    const approvedEmail = `${p}-approved@example.com`;
    const blockedEmail = `fb-${p}fb@facebook.local`;
    const pendingEmail = `${p}-pending@example.com`;
    const noRoleEmail = `${p}-norole@example.com`;
    const duplicateEmail = `${p}-dup@example.com`;
    const movedOldEmail = `${p}-moved-old@example.com`;
    const movedNewEmail = `${p}-moved-new@example.com`;

    const at = (minutes: number) => new Date(Date.UTC(2026, 0, 1, 0, minutes, 0));

    await tx.insert(accessRequests).values([
      // Same human approved in BOTH tenants -> one account, two memberships.
      {
        tenantId: tenantA,
        provider: "google",
        providerAccountId: `${p}-sub-approved`,
        sessionEmail: approvedEmail,
        email: approvedEmail,
        displayName: "Approved Person",
        status: "approved",
        role: "admin",
        requestedAt: at(0),
        decidedAt: at(1),
      },
      {
        tenantId: tenantB,
        provider: "google",
        providerAccountId: `${p}-sub-approved`,
        sessionEmail: approvedEmail,
        email: approvedEmail,
        displayName: "Approved Person",
        status: "approved",
        role: "viewer",
        requestedAt: at(2),
        decidedAt: at(3),
      },
      // Facebook, blocked: no e-mail, no display name — the columns must take it.
      {
        tenantId: tenantA,
        provider: "facebook",
        providerAccountId: `${p}fb`,
        sessionEmail: blockedEmail,
        email: null,
        displayName: null,
        status: "blocked",
        requestedAt: at(4),
      },
      // Never decided: state NoMembership.
      {
        tenantId: tenantA,
        provider: "google",
        providerAccountId: `${p}-sub-pending`,
        sessionEmail: pendingEmail,
        email: pendingEmail,
        displayName: "Pending Person",
        status: "pending",
        requestedAt: at(5),
      },
      // Approved but the role column is null — the fallback chain must fire.
      {
        tenantId: tenantB,
        provider: "google",
        providerAccountId: `${p}-sub-norole`,
        sessionEmail: noRoleEmail,
        email: noRoleEmail,
        displayName: "No Role Person",
        status: "approved",
        role: null,
        requestedAt: at(6),
        decidedAt: at(7),
      },
      // Two DIFFERENT provider identities claiming one address. Only one may win
      // `identity.session_email`; the loser must be reported, not crash the run.
      {
        tenantId: tenantA,
        provider: "google",
        providerAccountId: `${p}-sub-dup-a`,
        sessionEmail: duplicateEmail,
        email: duplicateEmail,
        displayName: "Dup A",
        status: "approved",
        role: "editor",
        requestedAt: at(8),
        decidedAt: at(9),
      },
      {
        tenantId: tenantB,
        provider: "google",
        providerAccountId: `${p}-sub-dup-b`,
        sessionEmail: duplicateEmail,
        email: duplicateEmail,
        displayName: "Dup B",
        status: "approved",
        role: "editor",
        requestedAt: at(10),
        decidedAt: at(11),
      },
      // One person, one Google `sub`, address changed between the two sign-ups.
      {
        tenantId: tenantA,
        provider: "google",
        providerAccountId: `${p}-sub-moved`,
        sessionEmail: movedOldEmail,
        email: movedOldEmail,
        displayName: "Moved Person",
        status: "approved",
        role: "editor",
        requestedAt: at(12),
        decidedAt: at(13),
      },
      {
        tenantId: tenantB,
        provider: "google",
        providerAccountId: `${p}-sub-moved`,
        sessionEmail: movedNewEmail,
        email: movedNewEmail,
        displayName: "Moved Person",
        status: "approved",
        role: "editor",
        requestedAt: at(14),
        decidedAt: at(15),
      },
    ]);

    // Existing domain actors: one to link, one to supply the missing role.
    await tx.insert(users).values([
      { tenantId: tenantA, email: approvedEmail, name: "Approved Person", role: "admin" },
      { tenantId: tenantB, email: noRoleEmail, name: "No Role Person", role: "editor" },
    ]);

    return {
      tenantA,
      tenantB,
      approvedEmail,
      blockedEmail,
      pendingEmail,
      noRoleEmail,
      duplicateEmail,
      movedOldEmail,
      movedNewEmail,
      emails: [
        approvedEmail,
        blockedEmail,
        pendingEmail,
        noRoleEmail,
        duplicateEmail,
        movedOldEmail,
        movedNewEmail,
      ],
    };
  };

  const identityByEmail = async (tx: DbExecutor, sessionEmail: string) => {
    const rows = await tx
      .select({
        accountId: identities.accountId,
        provider: identities.provider,
        providerAccountId: identities.providerAccountId,
        email: identities.email,
        status: accounts.status,
        displayName: accounts.displayName,
        platformRole: accounts.platformRole,
      })
      .from(identities)
      .innerJoin(accounts, eq(accounts.id, identities.accountId))
      .where(eq(identities.sessionEmail, sessionEmail))
      .limit(1);
    return rows[0] ?? null;
  };

  const membershipsOf = async (tx: DbExecutor, accountId: string) =>
    tx
      .select({
        tenantId: memberships.tenantId,
        role: memberships.role,
        status: memberships.status,
        version: memberships.version,
      })
      .from(memberships)
      .where(eq(memberships.accountId, accountId));

  it("gives an approved identity one account and one membership per tenant", async () => {
    await inRolledBackTx(handle.db, async (tx) => {
      const fx = await insertFixture(tx);
      await runBackfill(tx);

      const identity = await identityByEmail(tx, fx.approvedEmail);
      expect(identity).not.toBeNull();
      expect(identity?.status).toBe("active");
      expect(identity?.displayName).toBe("Approved Person");
      // Nobody is a platform admin by way of a backfill.
      expect(identity?.platformRole).toBeNull();

      const rows = await membershipsOf(tx, identity!.accountId);
      expect(rows).toHaveLength(2);
      expect(rows.every((row) => row.status === "active")).toBe(true);
      expect(rows.every((row) => row.version === 1)).toBe(true);
      expect(new Map(rows.map((row) => [row.tenantId, row.role]))).toEqual(
        new Map([
          [fx.tenantA, "admin"],
          [fx.tenantB, "viewer"],
        ]),
      );
    });
  });

  it("suspends a blocked identity and gives it NO membership", async () => {
    await inRolledBackTx(handle.db, async (tx) => {
      const fx = await insertFixture(tx);
      await runBackfill(tx);

      const identity = await identityByEmail(tx, fx.blockedEmail);
      expect(identity?.status).toBe("suspended");
      expect(identity?.provider).toBe("facebook");
      // Facebook returned neither an address nor a name; both columns stay null.
      expect(identity?.email).toBeNull();
      expect(identity?.displayName).toBeNull();
      await expect(membershipsOf(tx, identity!.accountId)).resolves.toEqual([]);
    });
  });

  it("creates an account for a pending identity but leaves it with no membership", async () => {
    await inRolledBackTx(handle.db, async (tx) => {
      const fx = await insertFixture(tx);
      await runBackfill(tx);

      const identity = await identityByEmail(tx, fx.pendingEmail);
      expect(identity?.status).toBe("active");
      await expect(membershipsOf(tx, identity!.accountId)).resolves.toEqual([]);
    });
  });

  it("falls back to the app_user role when an approved row has none", async () => {
    await inRolledBackTx(handle.db, async (tx) => {
      const fx = await insertFixture(tx);
      await runBackfill(tx);

      const identity = await identityByEmail(tx, fx.noRoleEmail);
      const rows = await membershipsOf(tx, identity!.accountId);
      expect(rows).toEqual([
        { tenantId: fx.tenantB, role: "editor", status: "active", version: 1 },
      ]);
    });
  });

  it("keeps ONE identity when two provider ids claim the same session address", async () => {
    await inRolledBackTx(handle.db, async (tx) => {
      const fx = await insertFixture(tx);
      await runBackfill(tx);

      const rows = await tx
        .select({ providerAccountId: identities.providerAccountId })
        .from(identities)
        .where(eq(identities.sessionEmail, fx.duplicateEmail));

      // The unique index leaves no choice; the winner is deterministic (lowest
      // provider_account_id), and the loser is the migration's RAISE WARNING.
      expect(rows).toHaveLength(1);
      expect(rows[0]?.providerAccountId).toMatch(/-sub-dup-a$/);
    });
  });

  it("keeps the NEWEST address when one provider id changed e-mail", async () => {
    await inRolledBackTx(handle.db, async (tx) => {
      const fx = await insertFixture(tx);
      await runBackfill(tx);

      expect(await identityByEmail(tx, fx.movedOldEmail)).toBeNull();
      const identity = await identityByEmail(tx, fx.movedNewEmail);
      expect(identity).not.toBeNull();
      // One person: both tenants' approvals land on the same account.
      const rows = await membershipsOf(tx, identity!.accountId);
      expect(rows.map((row) => row.tenantId).sort()).toEqual([fx.tenantA, fx.tenantB].sort());
    });
  });

  it("links the existing app_user and creates the missing one", async () => {
    await inRolledBackTx(handle.db, async (tx) => {
      const fx = await insertFixture(tx);
      await runBackfill(tx);

      const identity = await identityByEmail(tx, fx.approvedEmail);

      const linked = await tx
        .select({ id: users.id, accountId: users.accountId, role: users.role })
        .from(users)
        .where(and(eq(users.tenantId, fx.tenantA), eq(users.email, fx.approvedEmail)));
      expect(linked[0]?.accountId).toBe(identity!.accountId);
      // The backfill links; it does not rewrite the role the operator runs with.
      expect(linked[0]?.role).toBe("admin");

      // Tenant B had a membership but no domain actor — the invariant
      // "one active membership <-> one app_user" is restored.
      const created = await tx
        .select({ email: users.email, role: users.role, accountId: users.accountId })
        .from(users)
        .where(and(eq(users.tenantId, fx.tenantB), eq(users.email, fx.approvedEmail)));
      expect(created[0]).toEqual({
        email: fx.approvedEmail,
        role: "viewer",
        accountId: identity!.accountId,
      });
    });
  });

  it("gives an app_user with no registry row an account, an identity and a membership", async () => {
    await inRolledBackTx(handle.db, async (tx) => {
      const tenantId = testTenantId(randomUUID());
      const p = randomUUID().slice(0, 8);
      const email = `${p}-orphan@example.com`;
      await tx.insert(tenants).values({ id: tenantId, name: `M1.1 orphan ${p}` });
      await tx
        .insert(users)
        .values({ tenantId, email, name: "Env Bootstrap Operator", role: "owner" });

      await runBackfill(tx);

      const identity = await identityByEmail(tx, email);
      expect(identity?.provider).toBe("google");
      // Placeholder, not a real `sub` — greppable on purpose.
      expect(identity?.providerAccountId).toBe(`legacy-app-user:${email}`);
      await expect(membershipsOf(tx, identity!.accountId)).resolves.toEqual([
        { tenantId, role: "owner", status: "active", version: 1 },
      ]);
    });
  });

  it("matches a mixed-case app_user address to the identity that already exists", async () => {
    await inRolledBackTx(handle.db, async (tx) => {
      const p = randomUUID().slice(0, 8);
      const tenantA = testTenantId(randomUUID());
      const tenantB = testTenantId(randomUUID());
      const lower = `${p}-alice@example.com`;
      const mixed = `${p}-Alice@Example.com`;
      await tx.insert(tenants).values([
        { id: tenantA, name: `M1.1 case A ${p}` },
        { id: tenantB, name: `M1.1 case B ${p}` },
      ]);
      // The registry knows her in lower case; tenant B's app_user row was written
      // before anyone normalised. `app_user.email` is lower-cased by convention
      // only — the column does not enforce it.
      await tx.insert(accessRequests).values({
        tenantId: tenantA,
        provider: "google",
        providerAccountId: `${p}-sub-case`,
        sessionEmail: lower,
        email: lower,
        displayName: "Alice",
        status: "approved",
        role: "editor",
      });
      await tx
        .insert(users)
        .values({ tenantId: tenantB, email: mixed, name: "Alice", role: "admin" });

      await runBackfill(tx);

      // ONE person. A verbatim comparison mints a second account here and stores
      // `...Alice@Example.com` in session_email, which the M1.2 lookup (which
      // lower-cases the JWT address) can never match — tenant B would vanish
      // from her list with no error anywhere.
      const identityRows = await tx
        .select({ sessionEmail: identities.sessionEmail, accountId: identities.accountId })
        .from(identities)
        .where(inArray(identities.sessionEmail, [lower, mixed, mixed.toLowerCase()]));
      expect(identityRows).toHaveLength(1);
      expect(identityRows[0]?.sessionEmail).toBe(lower);

      const accountId = identityRows[0]!.accountId;
      const linked = await tx
        .select({ accountId: users.accountId })
        .from(users)
        .where(and(eq(users.tenantId, tenantB), eq(users.email, mixed)));
      expect(linked[0]?.accountId).toBe(accountId);

      const rows = await membershipsOf(tx, accountId);
      expect(rows.map((row) => row.tenantId).sort()).toEqual([tenantA, tenantB].sort());
    });
  });

  it("gives no membership and no new app_user to someone blocked in another tenant", async () => {
    await inRolledBackTx(handle.db, async (tx) => {
      const p = randomUUID().slice(0, 8);
      const tenantA = testTenantId(randomUUID());
      const tenantB = testTenantId(randomUUID());
      const email = `${p}-two-faced@example.com`;
      await tx.insert(tenants).values([
        { id: tenantA, name: `M1.1 ban A ${p}` },
        { id: tenantB, name: `M1.1 ban B ${p}` },
      ]);
      await tx.insert(accessRequests).values([
        {
          tenantId: tenantA,
          provider: "google",
          providerAccountId: `${p}-sub-two-faced`,
          sessionEmail: email,
          email,
          displayName: "Two Faced",
          status: "approved",
          role: "admin",
        },
        {
          tenantId: tenantB,
          provider: "google",
          providerAccountId: `${p}-sub-two-faced`,
          sessionEmail: email,
          email,
          displayName: "Two Faced",
          status: "blocked",
        },
      ]);

      await runBackfill(tx);

      const identity = await identityByEmail(tx, email);
      // Blocked wins across tenants — and the ban has to be ENFORCED, not merely
      // recorded: an active admin membership under a suspended account comes
      // back to life the day someone un-suspends for an unrelated reason.
      expect(identity?.status).toBe("suspended");
      await expect(membershipsOf(tx, identity!.accountId)).resolves.toEqual([]);

      // Nor may step 3 mint a domain actor for the banned person.
      const minted = await tx
        .select({ id: users.id })
        .from(users)
        .where(inArray(users.tenantId, [tenantA, tenantB]));
      expect(minted).toEqual([]);
    });
  });

  it("does NOT re-admit an app_user whose identity was blocked", async () => {
    await inRolledBackTx(handle.db, async (tx) => {
      const tenantId = testTenantId(randomUUID());
      const p = randomUUID().slice(0, 8);
      const email = `${p}-banned@example.com`;
      await tx.insert(tenants).values({ id: tenantId, name: `M1.1 banned ${p}` });
      // `decide('blocked')` does not delete the app_user an earlier approval
      // created — this is exactly the row that must not become a membership.
      await tx.insert(users).values({ tenantId, email, name: "Banned Person", role: "editor" });
      await tx.insert(accessRequests).values({
        tenantId,
        provider: "google",
        providerAccountId: `${p}-sub-banned`,
        sessionEmail: email,
        email,
        displayName: "Banned Person",
        status: "blocked",
      });

      await runBackfill(tx);

      const identity = await identityByEmail(tx, email);
      expect(identity?.status).toBe("suspended");
      await expect(membershipsOf(tx, identity!.accountId)).resolves.toEqual([]);
    });
  });

  it("is idempotent: a second run changes nothing", async () => {
    await inRolledBackTx(handle.db, async (tx) => {
      const fx = await insertFixture(tx);

      await runBackfill(tx);
      const snapshot = async () => {
        const accountRows = await tx
          .select({ id: accounts.id, status: accounts.status })
          .from(accounts)
          .innerJoin(identities, eq(identities.accountId, accounts.id))
          .where(inArray(identities.sessionEmail, fx.emails));
        const membershipRows = await tx
          .select({ tenantId: memberships.tenantId, role: memberships.role })
          .from(memberships)
          .where(inArray(memberships.tenantId, [fx.tenantA, fx.tenantB]));
        const userRows = await tx
          .select({ id: users.id, accountId: users.accountId, role: users.role })
          .from(users)
          .where(inArray(users.tenantId, [fx.tenantA, fx.tenantB]));
        return {
          accounts: accountRows.sort((a, b) => a.id.localeCompare(b.id)),
          memberships: membershipRows.sort((a, b) => a.tenantId.localeCompare(b.tenantId)),
          users: userRows.sort((a, b) => a.id.localeCompare(b.id)),
        };
      };

      const first = await snapshot();
      await runBackfill(tx);
      const second = await snapshot();

      expect(second).toEqual(first);
      // Sanity: the snapshot is not trivially empty.
      expect(first.accounts.length).toBeGreaterThan(0);
    });
  });

  it("labels only the audit rows whose actor the data proves", async () => {
    await inRolledBackTx(handle.db, async (tx) => {
      const tenantId = testTenantId(randomUUID());
      const p = randomUUID().slice(0, 8);
      await tx.insert(tenants).values({ id: tenantId, name: `M1.1 audit ${p}` });
      const inserted = await tx
        .insert(users)
        .values({ tenantId, email: `${p}-audit@example.com`, name: "Auditor", role: "admin" })
        .returning({ id: users.id });
      await tx.insert(auditLogs).values([
        { tenantId, actorUserId: inserted[0]!.id, action: "test.human", entityType: "test" },
        { tenantId, actorUserId: null, action: "test.faceless", entityType: "test" },
      ]);

      await runBackfill(tx);

      const rows = await tx
        .select({ action: auditLogs.action, actorKind: auditLogs.actorKind })
        .from(auditLogs)
        .where(eq(auditLogs.tenantId, tenantId));
      const byAction = new Map(rows.map((row) => [row.action, row.actorKind]));
      expect(byAction.get("test.human")).toBe("user");
      // Worker or unresolved operator — unknowable, so it stays unrecorded.
      expect(byAction.get("test.faceless")).toBeNull();
    });
  });

  it("puts MYSP's own tenant on the internal plan", async () => {
    await inRolledBackTx(handle.db, async (tx) => {
      await runBackfill(tx);
      const rows = await tx
        .select({ plan: tenants.plan, slug: tenants.slug })
        .from(tenants)
        .where(eq(tenants.id, testTenantId("00000000-0000-0000-0000-000000000001")));
      // Seeded databases only; an empty dev DB has no demo tenant to move.
      if (rows.length > 0) {
        expect(rows[0]?.plan).toBe("internal");
        expect(rows[0]?.slug).toBe("demo");
      }
    });
  });
});

describe.skipIf(!url)("M1.1 schema — the constraints the design leans on", () => {
  const handle = makeDbHandle({ url: url ?? "postgres://unused", maxPoolSize: 3 });

  afterAll(async () => {
    await handle.close();
  });

  it("refuses a second identity for the same session address", async () => {
    await inRolledBackTx(handle.db, async (tx) => {
      const p = randomUUID().slice(0, 8);
      const email = `${p}-unique@example.com`;
      const [account] = await tx.insert(accounts).values({}).returning({ id: accounts.id });
      const [other] = await tx.insert(accounts).values({}).returning({ id: accounts.id });
      await tx.insert(identities).values({
        accountId: account!.id,
        provider: "google",
        providerAccountId: `${p}-a`,
        sessionEmail: email,
      });

      // A savepoint: the failed insert would otherwise poison the transaction.
      // A DIFFERENT provider is deliberate — the address alone must be enough.
      const constraint = await violatedConstraint(() =>
        tx.transaction(async (nested) => {
          await nested.insert(identities).values({
            accountId: other!.id,
            provider: "facebook",
            providerAccountId: `${p}-b`,
            sessionEmail: email,
          });
        }),
      );
      expect(constraint).toBe("identity_session_email_uq");
    });
  });

  it("refuses a second identity for the same (provider, provider_account_id)", async () => {
    await inRolledBackTx(handle.db, async (tx) => {
      const p = randomUUID().slice(0, 8);
      const [account] = await tx.insert(accounts).values({}).returning({ id: accounts.id });
      await tx.insert(identities).values({
        accountId: account!.id,
        provider: "google",
        providerAccountId: `${p}-same`,
        sessionEmail: `${p}-one@example.com`,
      });

      const constraint = await violatedConstraint(() =>
        tx.transaction(async (nested) => {
          await nested.insert(identities).values({
            accountId: account!.id,
            provider: "google",
            providerAccountId: `${p}-same`,
            sessionEmail: `${p}-two@example.com`,
          });
        }),
      );
      expect(constraint).toBe("identity_provider_account_uq");
    });
  });

  it("refuses two memberships for one (tenant, account)", async () => {
    await inRolledBackTx(handle.db, async (tx) => {
      const p = randomUUID().slice(0, 8);
      const tenantId = testTenantId(randomUUID());
      await tx.insert(tenants).values({ id: tenantId, name: `M1.1 uq ${p}` });
      const [account] = await tx.insert(accounts).values({}).returning({ id: accounts.id });
      await tx.insert(memberships).values({ tenantId, accountId: account!.id, role: "editor" });

      const constraint = await violatedConstraint(() =>
        tx.transaction(async (nested) => {
          await nested
            .insert(memberships)
            .values({ tenantId, accountId: account!.id, role: "owner" });
        }),
      );
      expect(constraint).toBe("membership_tenant_account_uq");
    });
  });

  it("refuses two app_user rows for one (tenant, account) but tolerates many unlinked ones", async () => {
    await inRolledBackTx(handle.db, async (tx) => {
      const p = randomUUID().slice(0, 8);
      const tenantId = testTenantId(randomUUID());
      await tx.insert(tenants).values({ id: tenantId, name: `M1.1 actor ${p}` });
      const [account] = await tx.insert(accounts).values({}).returning({ id: accounts.id });
      await tx.insert(users).values({
        tenantId,
        accountId: account!.id,
        email: `${p}-a@example.com`,
        name: "A",
        role: "editor",
      });

      const constraint = await violatedConstraint(() =>
        tx.transaction(async (nested) => {
          await nested.insert(users).values({
            tenantId,
            accountId: account!.id,
            email: `${p}-b@example.com`,
            name: "B",
            role: "editor",
          });
        }),
      );
      expect(constraint).toBe("app_user_tenant_account_uq");

      // NULL account_id is distinct in a Postgres unique index — that is what
      // lets legacy rows that could not be linked keep existing side by side.
      await tx.insert(users).values([
        { tenantId, email: `${p}-c@example.com`, name: "C", role: "viewer" },
        { tenantId, email: `${p}-d@example.com`, name: "D", role: "viewer" },
      ]);
      const rows = await tx
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.tenantId, tenantId), sql`${users.accountId} is null`));
      expect(rows).toHaveLength(2);
    });
  });

  it("cascades a deleted account to identity and membership, but spares app_user", async () => {
    await inRolledBackTx(handle.db, async (tx) => {
      const p = randomUUID().slice(0, 8);
      const tenantId = testTenantId(randomUUID());
      await tx.insert(tenants).values({ id: tenantId, name: `M1.1 cascade ${p}` });
      const [account] = await tx.insert(accounts).values({}).returning({ id: accounts.id });
      await tx.insert(identities).values({
        accountId: account!.id,
        provider: "google",
        providerAccountId: `${p}-cascade`,
        sessionEmail: `${p}-cascade@example.com`,
      });
      await tx.insert(memberships).values({ tenantId, accountId: account!.id, role: "editor" });
      await tx.insert(users).values({
        tenantId,
        accountId: account!.id,
        email: `${p}-cascade@example.com`,
        name: "Cascade",
        role: "editor",
      });

      await tx.delete(accounts).where(eq(accounts.id, account!.id));

      await expect(
        tx.select().from(identities).where(eq(identities.accountId, account!.id)),
      ).resolves.toEqual([]);
      await expect(membershipsOfAccount(tx, account!.id)).resolves.toEqual([]);
      // The domain actor survives: drafts and audit rows still point at it.
      const survivors = await tx
        .select({ accountId: users.accountId })
        .from(users)
        .where(eq(users.tenantId, tenantId));
      expect(survivors).toEqual([{ accountId: null }]);
    });
  });

  it("cascades a deleted tenant to its memberships and invites", async () => {
    await inRolledBackTx(handle.db, async (tx) => {
      const p = randomUUID().slice(0, 8);
      const tenantId = testTenantId(randomUUID());
      await tx.insert(tenants).values({ id: tenantId, name: `M1.1 tenant cascade ${p}` });
      const [account] = await tx.insert(accounts).values({}).returning({ id: accounts.id });
      await tx.insert(memberships).values({ tenantId, accountId: account!.id, role: "editor" });

      await tx.delete(tenants).where(eq(tenants.id, tenantId));

      await expect(membershipsOfAccount(tx, account!.id)).resolves.toEqual([]);
      // The person outlives the company.
      const stillThere = await tx
        .select({ id: accounts.id })
        .from(accounts)
        .where(eq(accounts.id, account!.id));
      expect(stillThere).toHaveLength(1);
    });
  });
});

function membershipsOfAccount(tx: DbExecutor, accountId: string) {
  return tx.select({ id: memberships.id }).from(memberships).where(eq(memberships.accountId, accountId));
}
