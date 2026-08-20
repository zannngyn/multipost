import { randomUUID } from "node:crypto";

import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { testTenantId } from "@/core/domain/tenant-context.testing";
import type { LogBindings, Logger } from "@/core/ports/infra";

import { makeGlobalIdentityTestLock } from "./__fixtures__/global-identity-lock";
import { DrizzleAccountRepo } from "./account-repo.drizzle";
import { makeDbHandle } from "./client";
import { DrizzleMemberRepo } from "./member-repo.drizzle";
import {
  accounts,
  auditLogs,
  identities,
  memberships,
  postDrafts,
  tenants,
  users,
} from "./schema";

/**
 * M2.3/M2.4 — what a stubbed builder cannot honestly fake: the LAST_OWNER
 * count inside the transaction, the ladder against the FRESH target role, the
 * removed member's drafts going with them (doc 10 §8.8), and the provision
 * race of two identical first sign-ins.
 *
 * Runs only when TEST_DATABASE_URL points at a MIGRATED database.
 */

const url = process.env.TEST_DATABASE_URL;

function silentLogger(): Logger {
  const logger: Logger = {
    child: (_b: LogBindings) => logger,
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
  return logger;
}

describe.skipIf(!url)("Members + provisioning — the write path", () => {
  const handle = makeDbHandle({ url: url ?? "postgres://unused", maxPoolSize: 4 });
  const memberRepo = new DrizzleMemberRepo(handle.db, { logger: silentLogger() });
  const accountRepo = new DrizzleAccountRepo(handle.db, { logger: silentLogger() });

  // Creates account/identity rows (global tables) — serialise with the others.
  const globalLock = makeGlobalIdentityTestLock(url ?? "postgres://unused");

  const suffix = randomUUID().slice(0, 8);
  const tenantId = testTenantId(randomUUID());
  let ownerId = "";
  let editorId = "";

  const clean = async () => {
    for (const table of [auditLogs, postDrafts, memberships, users] as const) {
      await handle.db.delete(table).where(eq(table.tenantId, tenantId));
    }
    const mine = await handle.db
      .select({ accountId: identities.accountId, sessionEmail: identities.sessionEmail })
      .from(identities);
    const owned = [
      ...new Set(
        mine.filter((row) => row.sessionEmail.includes(suffix)).map((row) => row.accountId),
      ),
    ];
    // Fixed test accounts are dropped separately in afterAll.
    if (owned.length > 0) await handle.db.delete(accounts).where(inArray(accounts.id, owned));
  };

  /** Seeds an account + active membership; returns [accountId, membershipId]. */
  async function seedMember(role: "owner" | "admin" | "editor" | "viewer") {
    const accountRows = await handle.db
      .insert(accounts)
      .values({ displayName: `${role} ${suffix}` })
      .returning({ id: accounts.id });
    const membershipRows = await handle.db
      .insert(memberships)
      .values({ tenantId, accountId: accountRows[0].id, role, status: "active" })
      .returning({ id: memberships.id });
    return [accountRows[0].id, membershipRows[0].id] as const;
  }

  beforeAll(async () => {
    await globalLock.acquire();
    await handle.db
      .insert(tenants)
      .values({ id: tenantId, name: `M2.3 ${suffix}`, status: "active" });
  });

  beforeEach(async () => {
    await clean();
    // Standing cast: one owner, one editor.
    const owner = await seedMember("owner");
    ownerId = owner[0];
    const editor = await seedMember("editor");
    editorId = editor[0];
  });

  afterAll(async () => {
    await clean();
    await handle.db.delete(memberships).where(eq(memberships.tenantId, tenantId));
    await handle.db.delete(tenants).where(eq(tenants.id, tenantId));
    await handle.db
      .delete(accounts)
      .where(inArray(accounts.id, [ownerId, editorId].filter(Boolean)));
    await globalLock.release();
    await handle.close();
  });

  const membershipIdOf = async (accountId: string) => {
    const rows = await handle.db
      .select({ id: memberships.id })
      .from(memberships)
      .where(and(eq(memberships.tenantId, tenantId), eq(memberships.accountId, accountId)));
    return rows[0].id;
  };

  // --- LAST_OWNER (the check that must be transactional) ----------------------

  it("refuses to demote the LAST owner — even by the owner themselves", async () => {
    await expect(
      memberRepo.changeRole({
        tenantId,
        membershipId: await membershipIdOf(ownerId),
        newRole: "editor",
        actorRole: "owner",
        actorAccountId: ownerId,
        actorEmail: null,
      }),
    ).rejects.toMatchObject({ code: "LAST_OWNER" });
  });

  it("refuses the LAST owner leaving the company", async () => {
    await expect(
      memberRepo.removeMember({
        tenantId,
        membershipId: await membershipIdOf(ownerId),
        actorRole: "owner",
        actorAccountId: ownerId, // self-leave, still refused
        actorEmail: null,
      }),
    ).rejects.toMatchObject({ code: "LAST_OWNER" });
  });

  it("allows demoting an owner once a SECOND owner exists — with a version bump", async () => {
    await seedMember("owner");

    const result = await memberRepo.changeRole({
      tenantId,
      membershipId: await membershipIdOf(ownerId),
      newRole: "editor",
      actorRole: "owner",
      actorAccountId: ownerId,
      actorEmail: null,
    });

    expect(result).toMatchObject({ role: "editor", version: 2 });
  });

  it("TWO owners demoting EACH OTHER concurrently: one wins, LAST_OWNER stops the other (B1)", async () => {
    /**
     * Deterministic interleaving, the same rig as the tenant-creation race:
     * tx A takes the SAME per-tenant advisory lock the repo takes, demotes
     * owner #1 and holds the transaction open. changeRole(owner #2) starts
     * meanwhile — with the lock in place it must WAIT; once A commits it
     * counts a world where #1 is already an editor, sees #2 as the last
     * owner, and refuses. Remove the lock from the repo and B's count still
     * sees #1 active (READ COMMITTED) — both demotions land, zero owners.
     */
    const [secondOwnerId] = await seedMember("owner");
    const firstMembership = await membershipIdOf(ownerId);
    const secondMembership = await membershipIdOf(secondOwnerId);

    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    let releaseA: () => void = () => {};
    const holdA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });

    const txA = handle.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`tenant_members:${tenantId}`}))`,
      );
      await tx
        .update(memberships)
        .set({ role: "editor", version: sql`${memberships.version} + 1` })
        .where(eq(memberships.id, firstMembership));
      await holdA; // keep the lock + the uncommitted demotion alive
    });

    await sleep(150); // let A take the lock and demote #1
    const attemptB = memberRepo.changeRole({
      tenantId,
      membershipId: secondMembership,
      newRole: "editor",
      actorRole: "owner",
      actorAccountId: secondOwnerId,
      actorEmail: null,
    });
    await sleep(150); // B is now parked on the advisory lock (or, unlocked, done)

    releaseA();
    await txA;

    await expect(attemptB).rejects.toMatchObject({ code: "LAST_OWNER" });

    // And the DATABASE agrees: the company still has an active owner.
    const owners = await handle.db
      .select({ id: memberships.id })
      .from(memberships)
      .where(
        and(
          eq(memberships.tenantId, tenantId),
          eq(memberships.role, "owner"),
          eq(memberships.status, "active"),
        ),
      );
    expect(owners.length).toBeGreaterThanOrEqual(1);
  });

  it("demote + REMOVE racing the same way: the remove waits and hits LAST_OWNER (B1)", async () => {
    const [secondOwnerId] = await seedMember("owner");
    const firstMembership = await membershipIdOf(ownerId);
    const secondMembership = await membershipIdOf(secondOwnerId);

    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    let releaseA: () => void = () => {};
    const holdA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });

    const txA = handle.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`tenant_members:${tenantId}`}))`,
      );
      await tx
        .update(memberships)
        .set({ role: "viewer", version: sql`${memberships.version} + 1` })
        .where(eq(memberships.id, firstMembership));
      await holdA;
    });

    await sleep(150);
    const attemptB = memberRepo.removeMember({
      tenantId,
      membershipId: secondMembership,
      actorRole: "owner",
      actorAccountId: secondOwnerId, // self-leave of the (now) last owner
      actorEmail: null,
    });
    await sleep(150);

    releaseA();
    await txA;

    await expect(attemptB).rejects.toMatchObject({ code: "LAST_OWNER" });

    const owners = await handle.db
      .select({ id: memberships.id })
      .from(memberships)
      .where(
        and(
          eq(memberships.tenantId, tenantId),
          eq(memberships.role, "owner"),
          eq(memberships.status, "active"),
        ),
      );
    expect(owners.length).toBeGreaterThanOrEqual(1);
  });

  // --- The ladder, against the FRESH role -------------------------------------

  it("refuses an admin touching an owner (FORBIDDEN) — judged on the DB row, not the client's word", async () => {
    await expect(
      memberRepo.changeRole({
        tenantId,
        membershipId: await membershipIdOf(ownerId),
        newRole: "viewer",
        actorRole: "admin",
        actorAccountId: "someone-else",
        actorEmail: null,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("MEMBER_NOT_FOUND for another tenant's membership id", async () => {
    await expect(
      memberRepo.removeMember({
        tenantId,
        membershipId: randomUUID(),
        actorRole: "owner",
        actorAccountId: ownerId,
        actorEmail: null,
      }),
    ).rejects.toMatchObject({ code: "MEMBER_NOT_FOUND" });
  });

  // --- Removal: status flip + drafts go with them (doc 10 §8.8) ---------------

  it("removes a member: status=removed, version bump, app_user kept, DRAFTS deleted", async () => {
    // Give the editor an app_user + a server-side draft.
    const userRows = await handle.db
      .insert(users)
      .values({
        tenantId,
        email: `editor-${suffix}@x.vn`,
        name: "Editor",
        role: "editor",
        accountId: editorId,
      })
      .returning({ id: users.id });
    await handle.db.insert(postDrafts).values({
      tenantId,
      ownerUserId: userRows[0].id,
      kind: "compose",
      payload: { note: "secret draft" },
      schemaVersion: 1,
    });

    const result = await memberRepo.removeMember({
      tenantId,
      membershipId: await membershipIdOf(editorId),
      actorRole: "owner",
      actorAccountId: ownerId,
      actorEmail: `boss-${suffix}@x.vn`,
    });
    expect(result.version).toBe(2);

    const membershipRows = await handle.db
      .select({ status: memberships.status })
      .from(memberships)
      .where(and(eq(memberships.tenantId, tenantId), eq(memberships.accountId, editorId)));
    expect(membershipRows[0].status).toBe("removed");

    // app_user survives (audit FKs point at it); the drafts do not.
    const drafts = await handle.db
      .select()
      .from(postDrafts)
      .where(eq(postDrafts.ownerUserId, userRows[0].id));
    expect(drafts).toHaveLength(0);

    const audit = await handle.db
      .select({ action: auditLogs.action, actorKind: auditLogs.actorKind })
      .from(auditLogs)
      .where(eq(auditLogs.tenantId, tenantId));
    expect(audit).toEqual([{ action: "member.removed", actorKind: "user" }]);
  });

  it("keeps app_user.role in step on a role change — the M1.1 invariant", async () => {
    await handle.db.insert(users).values({
      tenantId,
      email: `editor-${suffix}@x.vn`,
      name: "Editor",
      role: "editor",
      accountId: editorId,
    });

    await memberRepo.changeRole({
      tenantId,
      membershipId: await membershipIdOf(editorId),
      newRole: "viewer",
      actorRole: "owner",
      actorAccountId: ownerId,
      actorEmail: null,
    });

    const rows = await handle.db
      .select({ role: users.role })
      .from(users)
      .where(and(eq(users.tenantId, tenantId), eq(users.accountId, editorId)));
    expect(rows[0].role).toBe("viewer");
  });

  // --- M2.4: provisioning ------------------------------------------------------

  it("provisions a first sign-in: account + identity, zero memberships", async () => {
    const sessionEmail = `newbie-${suffix}@x.vn`;
    const summary = await accountRepo.provisionAccount({
      provider: "google",
      providerAccountId: `sub-${suffix}`,
      sessionEmail,
      email: sessionEmail,
      displayName: "Newbie",
    });

    expect(summary.status).toBe("active");
    expect(summary.activeMemberships).toHaveLength(0);
    expect(summary.identity.providerAccountId).toBe(`sub-${suffix}`);
  });

  it("TWO RACING first sign-ins: one account, the loser adopts it", async () => {
    const sessionEmail = `racer-${suffix}@x.vn`;
    const provision = () =>
      accountRepo.provisionAccount({
        provider: "google",
        providerAccountId: `sub-race-${suffix}`,
        sessionEmail,
        email: sessionEmail,
        displayName: "Racer",
      });

    const [a, b] = await Promise.all([provision(), provision()]);

    expect(a.accountId).toBe(b.accountId); // adopted, not duplicated
    const rows = await handle.db
      .select()
      .from(identities)
      .where(eq(identities.sessionEmail, sessionEmail));
    expect(rows).toHaveLength(1);
  });
});
