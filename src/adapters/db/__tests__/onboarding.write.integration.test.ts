import { createHash, randomUUID } from "node:crypto";

import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { LogBindings, Logger } from "@/core/ports/infra";

import { makeGlobalIdentityTestLock } from "../__fixtures__/global-identity-lock";
import { makeDbHandle } from "../client";
import { DrizzleInviteRepo } from "../invite-repo.drizzle";
import { DrizzleTenantOnboardingRepo } from "../tenant-onboarding-repo.drizzle";
import { accounts, auditLogs, invites, memberships, tenants, users } from "../schema";

/**
 * M2.1/M2.2 — the write paths a stubbed query builder cannot honestly fake:
 * the abuse caps counted at their EXACT boundary behind the advisory lock, the
 * one-transaction tenant+owner+app_user chain, the row-locked single-use
 * invite claim under a real race, and the revive-not-duplicate rule for a
 * removed membership.
 *
 * Runs only when TEST_DATABASE_URL points at a MIGRATED database:
 *   TEST_DATABASE_URL=postgres://... pnpm vitest run src/adapters/db/onboarding.write.integration.test.ts
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

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

describe.skipIf(!url)("Onboarding write paths — tenant creation + invite claim", () => {
  const handle = makeDbHandle({ url: url ?? "postgres://unused", maxPoolSize: 4 });
  const onboarding = new DrizzleTenantOnboardingRepo(handle.db, { logger: silentLogger() });
  const inviteRepo = new DrizzleInviteRepo(handle.db, { logger: silentLogger() });

  // Creates account rows (global tables) — serialise with the backfill test.
  const globalLock = makeGlobalIdentityTestLock(url ?? "postgres://unused");

  const suffix = randomUUID().slice(0, 8);
  const NOW = new Date();
  let founderId = "";
  let joinerId = "";

  const clean = async () => {
    const owned = await handle.db
      .select({ id: tenants.id })
      .from(tenants)
      .where(inArray(tenants.createdByAccountId, [founderId, joinerId].filter(Boolean)));
    const tenantIds = owned.map((row) => row.id);
    if (tenantIds.length > 0) {
      for (const table of [auditLogs, invites, memberships, users] as const) {
        await handle.db.delete(table).where(inArray(table.tenantId, tenantIds));
      }
      await handle.db.delete(tenants).where(inArray(tenants.id, tenantIds));
    }
  };

  beforeAll(async () => {
    await globalLock.acquire();
    const rows = await handle.db
      .insert(accounts)
      .values([{ displayName: "Founder" }, { displayName: "Joiner" }])
      .returning({ id: accounts.id });
    founderId = rows[0].id;
    joinerId = rows[1].id;
  });

  beforeEach(async () => {
    await clean();
  });

  afterAll(async () => {
    await clean();
    await handle.db.delete(accounts).where(inArray(accounts.id, [founderId, joinerId]));
    await globalLock.release();
    await handle.close();
  });

  const createTenant = (slug: string, overrides: Partial<Parameters<typeof onboarding.createTenant>[0]> = {}) =>
    onboarding.createTenant({
      accountId: founderId,
      sessionEmail: `founder-${suffix}@x.vn`,
      displayName: "Founder",
      name: `Công ty ${slug}`,
      slug: `${slug}-${suffix}`,
      now: NOW,
      maxCreatedTotal: 3,
      maxCreatedPerHour: 3,
      ...overrides,
    });

  // --- M2.1 -------------------------------------------------------------------

  it("creates tenant + owner membership + app_user + audit in ONE act", async () => {
    const created = await createTenant("alpha");

    const membershipRows = await handle.db
      .select({ role: memberships.role, status: memberships.status })
      .from(memberships)
      .where(eq(memberships.tenantId, created.tenantId));
    expect(membershipRows).toEqual([{ role: "owner", status: "active" }]);

    const userRows = await handle.db
      .select({ accountId: users.accountId, role: users.role })
      .from(users)
      .where(eq(users.tenantId, created.tenantId));
    expect(userRows).toEqual([{ accountId: founderId, role: "owner" }]);

    const audit = await handle.db
      .select({ action: auditLogs.action, actorKind: auditLogs.actorKind })
      .from(auditLogs)
      .where(eq(auditLogs.tenantId, created.tenantId));
    expect(audit).toEqual([{ action: "tenant.created", actorKind: "user" }]);
  });

  it("SLUG_TAKEN on a duplicate slug — a refusal, not a 503", async () => {
    await createTenant("beta");
    await expect(createTenant("beta")).rejects.toMatchObject({ code: "SLUG_TAKEN" });
  });

  it("stops at EXACTLY the lifetime cap", async () => {
    await createTenant("one");
    await createTenant("two");
    await createTenant("three");
    await expect(createTenant("four")).rejects.toMatchObject({ code: "TENANT_LIMIT_REACHED" });
  });

  it("TWO RACING creates at the last free slot: exactly one tenant lands (V1)", async () => {
    /**
     * Deterministic interleaving, not a timing lottery: transaction A takes
     * the SAME advisory lock the repo takes, inserts founder's first tenant
     * and holds the transaction open. createTenant B starts meanwhile — with
     * the lock in place it must WAIT, and once A commits it counts the row
     * and refuses. Remove the lock from the repo and B counts 0 (A's row is
     * uncommitted under READ COMMITTED), inserts, and this test sees 2 rows.
     */
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    let releaseA: () => void = () => {};
    const holdA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });

    const txA = handle.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`tenant_create:${founderId}`}))`,
      );
      await tx.insert(tenants).values({
        name: "Race A",
        slug: `race-a-${suffix}`,
        status: "active",
        plan: "standard",
        createdByAccountId: founderId,
      });
      await holdA; // keep the lock + the uncommitted row alive
    });

    await sleep(150); // let A take the lock and insert
    const attemptB = createTenant("race-b", { maxCreatedPerHour: 1 });
    await sleep(150); // B is now parked on the advisory lock (or, unlocked, done)

    releaseA();
    await txA;

    await expect(attemptB).rejects.toMatchObject({ code: "TENANT_LIMIT_REACHED" });

    // And the DATABASE agrees: exactly the one row A committed.
    const rows = await handle.db
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.createdByAccountId, founderId));
    expect(rows).toHaveLength(1);
  });

  it("stops at EXACTLY the per-hour cap", async () => {
    await createTenant("hourly", { maxCreatedPerHour: 1 });
    await expect(createTenant("hourly2", { maxCreatedPerHour: 1 })).rejects.toMatchObject({
      code: "TENANT_LIMIT_REACHED",
    });
  });

  // --- M2.2 -------------------------------------------------------------------

  async function seedInvite(options: {
    role?: "owner" | "admin" | "editor" | "viewer";
    expiresAt?: Date;
    revoked?: boolean;
    maxUses?: number;
  } = {}) {
    const created = await createTenant(`inv-${randomUUID().slice(0, 6)}`);
    const token = randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
    const rows = await handle.db
      .insert(invites)
      .values({
        tenantId: created.tenantId,
        tokenHash: sha256(token),
        role: options.role ?? "editor",
        expiresAt: options.expiresAt ?? new Date(NOW.getTime() + 60_000),
        maxUses: options.maxUses ?? 1,
        createdByAccountId: founderId,
        revokedAt: options.revoked ? NOW : null,
      })
      .returning({ id: invites.id });
    return { tenantId: created.tenantId, token, inviteId: rows[0].id };
  }

  const claim = (token: string, accountId = joinerId) =>
    inviteRepo.claimInvite({
      tokenHash: sha256(token),
      accountId,
      sessionEmail: `joiner-${suffix}@x.vn`,
      displayName: "Joiner",
      now: new Date(),
    });

  it("claims once: membership + app_user + used_count + audit, one transaction", async () => {
    const { tenantId, token, inviteId } = await seedInvite();

    const result = await claim(token);
    expect(result.kind).toBe("joined");

    const membershipRows = await handle.db
      .select({ role: memberships.role, status: memberships.status })
      .from(memberships)
      .where(eq(memberships.accountId, joinerId));
    expect(membershipRows).toEqual([{ role: "editor", status: "active" }]);

    const inviteRows = await handle.db
      .select({ usedCount: invites.usedCount })
      .from(invites)
      .where(eq(invites.id, inviteId));
    expect(inviteRows[0].usedCount).toBe(1);

    const audit = await handle.db
      .select({ action: auditLogs.action })
      .from(auditLogs)
      .where(eq(auditLogs.tenantId, tenantId));
    expect(audit.map((row) => row.action)).toContain("invite.accepted");
  });

  it("TWO RACING claims of a single-use link: exactly one wins", async () => {
    // Two OUTSIDE accounts (an existing member would no-op without burning).
    const outsiderRows = await handle.db
      .insert(accounts)
      .values([{ displayName: "R1" }, { displayName: "R2" }])
      .returning({ id: accounts.id });
    const { token: token2 } = await seedInvite();
    const [r1, r2] = await Promise.all([
      claim(token2, outsiderRows[0].id),
      claim(token2, outsiderRows[1].id),
    ]);
    const winners = [r1, r2].filter((result) => result.kind === "joined");
    const losers = [r1, r2].filter(
      (result) => result.kind === "invalid" && result.reason === "USED_UP",
    );
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);

    await handle.db
      .delete(accounts)
      .where(inArray(accounts.id, outsiderRows.map((row) => row.id)));
  });

  it.each([
    ["expired", { expiresAt: new Date(Date.now() - 1000) }, "EXPIRED"],
    ["revoked", { revoked: true }, "REVOKED"],
  ] as const)("refuses an %s invite with the logged reason", async (_label, options, reason) => {
    const { token } = await seedInvite(options);
    const result = await claim(token);
    expect(result).toMatchObject({ kind: "invalid", reason });
  });

  it("already-member no-op burns NO use and keeps the current role", async () => {
    const { token } = await seedInvite({ role: "viewer" });
    // founder is the owner of the freshly created tenant.
    const result = await claim(token, founderId);

    expect(result).toMatchObject({ kind: "already_member", role: "owner" });
    const inviteRows = await handle.db
      .select({ usedCount: invites.usedCount })
      .from(invites)
      .where(eq(invites.tokenHash, sha256(token)));
    expect(inviteRows[0].usedCount).toBe(0);
  });

  it("REVIVES a removed membership on the same row, role from the invite, version bumped", async () => {
    const { tenantId, token } = await seedInvite({ role: "viewer" });
    // The joiner was once an editor, then removed.
    await handle.db.insert(memberships).values({
      tenantId,
      accountId: joinerId,
      role: "editor",
      status: "removed",
      version: 4,
    });

    const result = await claim(token);
    expect(result).toMatchObject({ kind: "joined", role: "viewer" });

    const rows = await handle.db
      .select({ role: memberships.role, status: memberships.status, version: memberships.version })
      .from(memberships)
      .where(eq(memberships.accountId, joinerId));
    expect(rows).toEqual([{ role: "viewer", status: "active", version: 5 }]); // same row, bumped
  });
});
