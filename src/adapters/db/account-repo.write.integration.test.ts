import { randomUUID } from "node:crypto";

import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { LogBindings, Logger } from "@/core/ports/infra";

import { DrizzleAccessRequestRepo } from "./access-request-repo.drizzle";
import { DrizzleAccountRepo } from "./account-repo.drizzle";
import { makeDbHandle } from "./client";
import {
  accessRequests,
  accounts,
  auditLogs,
  identities,
  memberships,
  tenants,
  users,
} from "./schema";
import { makeGlobalIdentityTestLock } from "./__fixtures__/global-identity-lock";
import { testTenantId } from "@/core/domain/tenant-context.testing";

/**
 * M1.2 write paths a stubbed query builder cannot honestly fake:
 *
 * 1. `attachProviderAccountId` PATCHES the `legacy-app-user:*` placeholder the
 *    M1.1 backfill minted — in place, never as an insert (the reviewer-named
 *    obligation: an upsert keyed on (provider, sub) would collide with
 *    `identity_session_email_uq`);
 * 2. `decide(approve)` provisions account+identity+membership+app_user link in
 *    ONE transaction — without it the approved person cannot sign in at all;
 * 3. `decide(block)` suspends the account and removes every membership, with a
 *    version bump (cross-process revocation).
 *
 * Runs only when TEST_DATABASE_URL points at a MIGRATED database:
 *   TEST_DATABASE_URL=postgres://... pnpm test src/adapters/db/account-repo.write.integration.test.ts
 */

const url = process.env.TEST_DATABASE_URL;

function silentLogger(): Logger {
  const logger: Logger = {
    child: (_bindings: LogBindings) => logger,
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
  return logger;
}

describe.skipIf(!url)("DrizzleAccountRepo + decide provisioning — the write path", () => {
  const handle = makeDbHandle({ url: url ?? "postgres://unused", maxPoolSize: 3 });
  const accountRepo = new DrizzleAccountRepo(handle.db, { logger: silentLogger() });
  const accessRepo = new DrizzleAccessRequestRepo(handle.db, { logger: silentLogger() });

  const tenantId = testTenantId(randomUUID());
  const tenantIdB = testTenantId(randomUUID());
  /** Unique per run so parallel/leftover rows can never collide. */
  const suffix = randomUUID().slice(0, 8);
  const email = (name: string) => `${name}-${suffix}@example.org`;

  const clean = async () => {
    for (const table of [auditLogs, accessRequests, memberships, users] as const) {
      await handle.db.delete(table).where(inArray(table.tenantId, [tenantId, tenantIdB]));
    }
    // Identities/accounts are GLOBAL tables — remove only what this run minted,
    // recognisable by the per-run suffix in every session address. Deleting the
    // accounts cascades to their identities and any leftover memberships.
    const mine = await handle.db
      .select({ accountId: identities.accountId, sessionEmail: identities.sessionEmail })
      .from(identities);
    const ownedAccountIds = [
      ...new Set(
        mine.filter((row) => row.sessionEmail.includes(suffix)).map((row) => row.accountId),
      ),
    ];
    if (ownedAccountIds.length > 0) {
      await handle.db.delete(accounts).where(inArray(accounts.id, ownedAccountIds));
    }
  };

  // Writes global identity rows — same serialisation as the other two files.
  const globalLock = makeGlobalIdentityTestLock(url ?? "postgres://unused");
  beforeAll(() => globalLock.acquire());

  beforeEach(async () => {
    await clean();
    await handle.db
      .insert(tenants)
      .values([
        { id: tenantId, name: `M1.2 A ${suffix}`, status: "active" },
        { id: tenantIdB, name: `M1.2 B ${suffix}`, status: "active" },
      ])
      .onConflictDoNothing();
  });

  afterAll(async () => {
    await clean();
    await handle.db.delete(tenants).where(inArray(tenants.id, [tenantId, tenantIdB]));
    await globalLock.release();
    await handle.close();
  });

  /** Seeds a backfill-shaped person: account + placeholder identity + membership. */
  async function seedBackfilledOperator(sessionEmail: string) {
    const accountRows = await handle.db
      .insert(accounts)
      .values({ displayName: "Backfilled Operator" })
      .returning({ id: accounts.id });
    const accountId = accountRows[0].id;
    await handle.db.insert(identities).values({
      accountId,
      provider: "google",
      providerAccountId: `legacy-app-user:${sessionEmail}`,
      sessionEmail,
      email: sessionEmail,
    });
    await handle.db
      .insert(memberships)
      .values({ tenantId, accountId, role: "editor", status: "active" });
    return accountId;
  }

  // --- 1. The reviewer-named patch path --------------------------------------

  it("patches the legacy placeholder IN PLACE — same row, same account, no insert", async () => {
    const sessionEmail = email("subject");
    const accountId = await seedBackfilledOperator(sessionEmail);

    const before = await handle.db
      .select({ id: identities.id })
      .from(identities)
      .where(eq(identities.accountId, accountId));

    const patched = await accountRepo.attachProviderAccountId({
      provider: "google",
      sessionEmail: sessionEmail.toUpperCase(), // case-fold at the boundary
      providerAccountId: "real-sub-109876",
    });

    expect(patched).toBe(true);
    const after = await handle.db
      .select()
      .from(identities)
      .where(eq(identities.accountId, accountId));
    expect(after).toHaveLength(1); // patched, never a second row
    expect(after[0].id).toBe(before[0].id);
    expect(after[0].providerAccountId).toBe("real-sub-109876");
  });

  it("REFUSES to overwrite a REAL sub — the recycled-address takeover, at the SQL layer", async () => {
    const sessionEmail = email("subject");
    const accountId = await seedBackfilledOperator(sessionEmail);
    // Give the identity its real sub (as a first sign-in would have).
    await handle.db
      .update(identities)
      .set({ providerAccountId: "REAL-SUB-AAA" })
      .where(eq(identities.accountId, accountId));

    // A different person now owns the recycled address and signs in.
    const patched = await accountRepo.attachProviderAccountId({
      provider: "google",
      sessionEmail,
      providerAccountId: "REAL-SUB-BBB",
    });

    expect(patched).toBe(false);
    const rows = await handle.db
      .select({ providerAccountId: identities.providerAccountId })
      .from(identities)
      .where(eq(identities.accountId, accountId));
    expect(rows[0].providerAccountId).toBe("REAL-SUB-AAA"); // untouched
  });

  it("answers a clean refusal, not DB_ERROR, when the real sub already belongs to another identity", async () => {
    const sessionEmail = email("subject");
    await seedBackfilledOperator(sessionEmail);
    // A second person already owns the sub the patch would write.
    const otherEmail = email("other");
    const otherAccount = await handle.db
      .insert(accounts)
      .values({ displayName: "Owner Of The Sub" })
      .returning({ id: accounts.id });
    await handle.db.insert(identities).values({
      accountId: otherAccount[0].id,
      provider: "google",
      providerAccountId: "TAKEN-SUB-1",
      sessionEmail: otherEmail,
      email: otherEmail,
    });

    // 23505 inside → false outside; a sign-in must not turn this into a 503.
    await expect(
      accountRepo.attachProviderAccountId({
        provider: "google",
        sessionEmail,
        providerAccountId: "TAKEN-SUB-1",
      }),
    ).resolves.toBe(false);
  });

  it("does not cross providers: a facebook patch cannot touch a google identity", async () => {
    const sessionEmail = email("subject");
    await seedBackfilledOperator(sessionEmail);

    const patched = await accountRepo.attachProviderAccountId({
      provider: "facebook",
      sessionEmail,
      providerAccountId: "999",
    });

    expect(patched).toBe(false);
  });

  // --- 2. Session lookup ------------------------------------------------------

  it("resolves identity → account → ACTIVE memberships, case-folded", async () => {
    const sessionEmail = email("subject");
    const accountId = await seedBackfilledOperator(sessionEmail);
    await handle.db
      .insert(memberships)
      .values({ tenantId: tenantIdB, accountId, role: "viewer", status: "removed" });

    const summary = await accountRepo.findAccountBySessionEmail(sessionEmail.toUpperCase());

    expect(summary).toMatchObject({ accountId, status: "active" });
    expect(summary?.activeMemberships).toEqual([
      { tenantId, role: "editor", version: 1 },
    ]);
  });

  // --- 3. decide(approve) provisions the chain --------------------------------

  it("approve creates account+identity+membership+app_user link in one decision", async () => {
    const sessionEmail = email("subject");
    const created = await accessRepo.createPending({
      tenantId,
      identity: {
        provider: "google",
        providerAccountId: "fresh-sub-1",
        sessionEmail,
        email: sessionEmail,
        displayName: "Fresh Person",
      },
      requestedAt: new Date(),
    });

    await accessRepo.decide({
      tenantId,
      id: created.id,
      status: "approved",
      role: "editor",
      decidedAt: new Date(),
      decidedByUserId: null,
      decidedByEmail: null,
    });

    const summary = await accountRepo.findAccountBySessionEmail(sessionEmail);
    expect(summary).toMatchObject({ status: "active" });
    expect(summary?.identity.providerAccountId).toBe("fresh-sub-1");
    expect(summary?.activeMemberships).toEqual([{ tenantId, role: "editor", version: 1 }]);

    // app_user carries the account link (the DB-held 1:1 invariant of M1.1).
    const operatorRows = await handle.db
      .select({ accountId: users.accountId })
      .from(users)
      .where(eq(users.email, sessionEmail));
    expect(operatorRows[0]?.accountId).toBe(summary?.accountId);
  });

  it("approve REUSES a backfilled account and patches its placeholder sub", async () => {
    const sessionEmail = email("subject");
    const accountId = await seedBackfilledOperator(sessionEmail);
    // The registry row carries the real sub the person signed in with.
    const created = await accessRepo.createPending({
      tenantId: tenantIdB,
      identity: {
        provider: "google",
        providerAccountId: "real-sub-42",
        sessionEmail,
        email: sessionEmail,
        displayName: "Same Person",
      },
      requestedAt: new Date(),
    });

    await accessRepo.decide({
      tenantId: tenantIdB,
      id: created.id,
      status: "approved",
      role: "admin",
      decidedAt: new Date(),
      decidedByUserId: null,
      decidedByEmail: null,
    });

    // Still ONE account, now with TWO memberships and the patched sub.
    const identityRows = await handle.db
      .select()
      .from(identities)
      .where(eq(identities.accountId, accountId));
    expect(identityRows).toHaveLength(1);
    expect(identityRows[0].providerAccountId).toBe("real-sub-42");

    const summary = await accountRepo.findAccountBySessionEmail(sessionEmail);
    expect(summary?.accountId).toBe(accountId);
    expect(summary?.activeMemberships).toHaveLength(2);
  });

  it("approve FAILS loudly when the stored sub is real and differs (N2)", async () => {
    const sessionEmail = email("subject");
    const accountId = await seedBackfilledOperator(sessionEmail);
    await handle.db
      .update(identities)
      .set({ providerAccountId: "REAL-SUB-AAA" })
      .where(eq(identities.accountId, accountId));

    const created = await accessRepo.createPending({
      tenantId: tenantIdB,
      identity: {
        provider: "google",
        providerAccountId: "REAL-SUB-BBB", // a different person, recycled address
        sessionEmail,
        email: sessionEmail,
        displayName: "Impostor",
      },
      requestedAt: new Date(),
    });

    await expect(
      accessRepo.decide({
        tenantId: tenantIdB,
        id: created.id,
        status: "approved",
        role: "editor",
        decidedAt: new Date(),
        decidedByUserId: null,
        decidedByEmail: null,
      }),
    ).rejects.toMatchObject({ code: "INTERNAL" });

    // Nothing was grafted: the sub is untouched and no new membership exists.
    const identityRows = await handle.db
      .select({ providerAccountId: identities.providerAccountId })
      .from(identities)
      .where(eq(identities.accountId, accountId));
    expect(identityRows[0].providerAccountId).toBe("REAL-SUB-AAA");
    const membershipRows = await handle.db
      .select()
      .from(memberships)
      .where(eq(memberships.tenantId, tenantIdB));
    expect(membershipRows).toHaveLength(0);
  });

  it("block does NOT suspend an identity owned by another provider (N3)", async () => {
    const sessionEmail = email("subject");
    // A GOOGLE identity owns this address.
    const accountId = await seedBackfilledOperator(sessionEmail);

    // A FACEBOOK registry row somehow carries the same address; blocking it
    // must not reach the google person's account.
    const created = await accessRepo.createPending({
      tenantId,
      identity: {
        provider: "facebook",
        providerAccountId: "555000",
        sessionEmail,
        email: null,
        displayName: null,
      },
      requestedAt: new Date(),
    });
    await accessRepo.decide({
      tenantId,
      id: created.id,
      status: "blocked",
      role: null,
      decidedAt: new Date(),
      decidedByUserId: null,
      decidedByEmail: null,
    });

    const accountRows = await handle.db
      .select({ status: accounts.status })
      .from(accounts)
      .where(eq(accounts.id, accountId));
    expect(accountRows[0].status).toBe("active"); // untouched
  });

  it("re-approving with another role bumps the membership version", async () => {
    const sessionEmail = email("subject");
    const created = await accessRepo.createPending({
      tenantId,
      identity: {
        provider: "google",
        providerAccountId: "sub-vs",
        sessionEmail,
        email: sessionEmail,
        displayName: null,
      },
      requestedAt: new Date(),
    });
    const decideAs = (role: "editor" | "admin") =>
      accessRepo.decide({
        tenantId,
        id: created.id,
        status: "approved",
        role,
        decidedAt: new Date(),
        decidedByUserId: null,
        decidedByEmail: null,
      });

    await decideAs("editor");
    await decideAs("editor"); // identical: must NOT bump
    let summary = await accountRepo.findAccountBySessionEmail(sessionEmail);
    expect(summary?.activeMemberships[0]).toMatchObject({ role: "editor", version: 1 });

    await decideAs("admin"); // real change: bump
    summary = await accountRepo.findAccountBySessionEmail(sessionEmail);
    expect(summary?.activeMemberships[0]).toMatchObject({ role: "admin", version: 2 });
  });

  // --- 4. decide(block) suspends platform-wide --------------------------------

  it("block suspends the account and removes EVERY membership with a version bump", async () => {
    const sessionEmail = email("subject");
    const accountId = await seedBackfilledOperator(sessionEmail);
    await handle.db
      .insert(memberships)
      .values({ tenantId: tenantIdB, accountId, role: "viewer", status: "active" });

    const created = await accessRepo.createPending({
      tenantId,
      identity: {
        provider: "google",
        providerAccountId: `legacy-app-user:${sessionEmail}`,
        sessionEmail,
        email: sessionEmail,
        displayName: null,
      },
      requestedAt: new Date(),
    });
    await accessRepo.decide({
      tenantId,
      id: created.id,
      status: "blocked",
      role: null,
      decidedAt: new Date(),
      decidedByUserId: null,
      decidedByEmail: "boss@mysp.vn",
    });

    const accountRows = await handle.db
      .select({ status: accounts.status })
      .from(accounts)
      .where(eq(accounts.id, accountId));
    expect(accountRows[0].status).toBe("suspended");

    const membershipRows = await handle.db
      .select({ status: memberships.status, version: memberships.version })
      .from(memberships)
      .where(eq(memberships.accountId, accountId));
    expect(membershipRows).toHaveLength(2);
    for (const row of membershipRows) {
      expect(row.status).toBe("removed"); // blocked wins ACROSS tenants
      expect(row.version).toBe(2); // bump → cross-process caches die
    }

    // And the session lookup now answers "no way in".
    const summary = await accountRepo.findAccountBySessionEmail(sessionEmail);
    expect(summary?.status).toBe("suspended");
    expect(summary?.activeMemberships).toHaveLength(0);
  });

  it("re-approval after a block reactivates the account and the membership", async () => {
    const sessionEmail = email("subject");
    const created = await accessRepo.createPending({
      tenantId,
      identity: {
        provider: "google",
        providerAccountId: "sub-cycle",
        sessionEmail,
        email: sessionEmail,
        displayName: null,
      },
      requestedAt: new Date(),
    });
    const decide = (status: "approved" | "blocked", role: "editor" | null) =>
      accessRepo.decide({
        tenantId,
        id: created.id,
        status,
        role,
        decidedAt: new Date(),
        decidedByUserId: null,
        decidedByEmail: null,
      });

    await decide("approved", "editor");
    await decide("blocked", null);
    await decide("approved", "editor");

    const summary = await accountRepo.findAccountBySessionEmail(sessionEmail);
    expect(summary?.status).toBe("active");
    // removed→active is a change: the version moved twice past the initial 1.
    expect(summary?.activeMemberships).toEqual([{ tenantId, role: "editor", version: 3 }]);
  });
});
