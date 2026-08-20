import { createHash, randomUUID } from "node:crypto";

import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { testTenantId } from "@/core/domain/tenant-context.testing";
import type { TenantId } from "@/core/domain/tenant-context";
import type { LogBindings, Logger } from "@/core/ports/infra";

import { makeGlobalIdentityTestLock } from "./__fixtures__/global-identity-lock";
import { DrizzleAccountRepo } from "./account-repo.drizzle";
import { makeDbHandle } from "./client";
import { DrizzleInviteRepo } from "./invite-repo.drizzle";
import { DrizzlePlatformTenantRepo } from "./platform-tenant-repo.drizzle";
import { accounts, auditLogs, invites, memberships, tenants, users } from "./schema";

/**
 * M3.1/M3.2 write paths on real Postgres:
 *   - the ONE-TIME bootstrap promotion under a real race (two concurrent
 *     grants → one winner, one audit row);
 *   - N9 by the book: suspend the account → `findPlatformStanding` (the fresh
 *     read every platform op makes) refuses immediately;
 *   - platform tenant provisioning: no creator membership, an owner invite
 *     that actually claims, and the audit trail;
 *   - idempotent status switches with mandatory-reason audits.
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

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

describe.skipIf(!url)("Platform admin — the write path", () => {
  const handle = makeDbHandle({ url: url ?? "postgres://unused", maxPoolSize: 4 });
  const accountRepo = new DrizzleAccountRepo(handle.db, { logger: silentLogger() });
  const platformRepo = new DrizzlePlatformTenantRepo(handle.db, { logger: silentLogger() });
  const inviteRepo = new DrizzleInviteRepo(handle.db, { logger: silentLogger() });

  // Creates account rows (global) — serialise with the other global-table files.
  const globalLock = makeGlobalIdentityTestLock(url ?? "postgres://unused");

  const suffix = randomUUID().slice(0, 8);
  let adminId = "";
  let joinerId = "";
  const createdTenantIds: TenantId[] = [];

  const clean = async () => {
    // The promote audit is tenant-less (0015) — remove only this run's rows,
    // keyed by the accounts the run minted. No seeded tenant is assumed:
    // this file must stay green on a COMPLETELY BLANK database (B2).
    await handle.db
      .delete(auditLogs)
      .where(
        and(
          eq(auditLogs.action, "platform.role_granted"),
          inArray(auditLogs.entityId, [adminId, joinerId].filter(Boolean)),
        ),
      );
    if (createdTenantIds.length > 0) {
      for (const table of [auditLogs, invites, memberships, users] as const) {
        await handle.db
          .delete(table)
          .where(inArray(table.tenantId, createdTenantIds));
      }
      await handle.db.delete(tenants).where(inArray(tenants.id, createdTenantIds));
    }
    await handle.db
      .delete(accounts)
      .where(inArray(accounts.id, [adminId, joinerId].filter(Boolean)));
  };

  beforeAll(async () => {
    await globalLock.acquire();
    const rows = await handle.db
      .insert(accounts)
      .values([{ displayName: `Root ${suffix}` }, { displayName: `Joiner ${suffix}` }])
      .returning({ id: accounts.id });
    adminId = rows[0].id;
    joinerId = rows[1].id;
  });

  afterAll(async () => {
    await clean();
    await globalLock.release();
    await handle.close();
  });

  // --- M3.1 -------------------------------------------------------------------

  it("promotes ONCE under a real race: one winner, one audit row", async () => {
    const [a, b] = await Promise.all([
      accountRepo.grantBootstrapPlatformRole(adminId, `root-${suffix}@mysp.vn`),
      accountRepo.grantBootstrapPlatformRole(adminId, `root-${suffix}@mysp.vn`),
    ]);

    expect([a, b].filter(Boolean)).toHaveLength(1); // exactly one granted

    const standing = await accountRepo.findPlatformStanding(adminId);
    expect(standing).toEqual({ status: "active", platformRole: "super_admin" });

    const audit = await handle.db
      .select({ id: auditLogs.id, actorKind: auditLogs.actorKind, tenantId: auditLogs.tenantId })
      .from(auditLogs)
      .where(
        and(eq(auditLogs.action, "platform.role_granted"), eq(auditLogs.entityId, adminId)),
      );
    expect(audit).toHaveLength(1); // ONE grant, ONE book entry
    expect(audit[0].actorKind).toBe("system");
    // Platform/account-level event: NO tenant — the exact shape that used to
    // FK-bomb the promote on a blank database (B1).
    expect(audit[0].tenantId).toBeNull();
  });

  it("a repeated grant after the fact is a no-op — the role is never re-stamped", async () => {
    await expect(
      accountRepo.grantBootstrapPlatformRole(adminId, `root-${suffix}@mysp.vn`),
    ).resolves.toBe(false);
  });

  it("N9: suspending the account kills the FRESH platform standing immediately", async () => {
    await handle.db.update(accounts).set({ status: "suspended" }).where(eq(accounts.id, adminId));

    const standing = await accountRepo.findPlatformStanding(adminId);
    expect(standing?.status).toBe("suspended"); // requirePlatformAdmin refuses on this

    await handle.db.update(accounts).set({ status: "active" }).where(eq(accounts.id, adminId));
  });

  // --- M3.2 -------------------------------------------------------------------

  it("provisions a customer tenant: NO creator membership, a claimable owner invite, audited", async () => {
    const created = await platformRepo.createTenant({
      name: `Khách ${suffix}`,
      slug: `khach-${suffix}`,
      plan: "standard",
      actorAccountId: adminId,
      actorEmail: `root-${suffix}@mysp.vn`,
    });
    createdTenantIds.push(created.id);

    // MYSP staff are NOT members of the customer's company.
    const membershipRows = await handle.db
      .select()
      .from(memberships)
      .where(eq(memberships.tenantId, created.id));
    expect(membershipRows).toHaveLength(0);

    // The owner invite (minted the way the usecase does) claims into OWNER.
    const token = randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
    await inviteRepo.createInvite({
      tenantId: created.id,
      role: "owner",
      tokenHash: sha256(token),
      expiresAt: new Date(Date.now() + 60_000),
      maxUses: 1,
      createdByAccountId: adminId,
      actorEmail: null,
    });
    const claim = await inviteRepo.claimInvite({
      tokenHash: sha256(token),
      accountId: joinerId,
      sessionEmail: `owner-${suffix}@shop.vn`,
      displayName: "Chủ shop",
      now: new Date(),
    });
    expect(claim).toMatchObject({ kind: "joined", role: "owner" });

    const audit = await handle.db
      .select({ action: auditLogs.action })
      .from(auditLogs)
      .where(eq(auditLogs.tenantId, created.id));
    expect(audit.map((row) => row.action)).toContain("platform.tenant_created");

    // And the platform list sees the new company with its one owner.
    const list = await platformRepo.listTenants();
    const mine = list.find((item) => item.id === created.id);
    expect(mine).toMatchObject({ slug: `khach-${suffix}`, memberCount: 1, status: "active" });
  });

  it("suspend bites, is idempotent, and both switches leave reasoned audit rows", async () => {
    const created = await platformRepo.createTenant({
      name: `Khoá ${suffix}`,
      slug: `khoa-${suffix}`,
      plan: "standard",
      actorAccountId: adminId,
      actorEmail: null,
    });
    createdTenantIds.push(created.id);

    const suspended = await platformRepo.setStatus({
      tenantId: created.id,
      status: "suspended",
      reason: "Khách nợ phí 3 tháng liên tiếp",
      actorAccountId: adminId,
      actorEmail: null,
    });
    expect(suspended).toMatchObject({ status: "suspended", already: false });

    // Idempotent: same state again → already, and NO second audit row.
    const again = await platformRepo.setStatus({
      tenantId: created.id,
      status: "suspended",
      reason: "Khách nợ phí 3 tháng liên tiếp",
      actorAccountId: adminId,
      actorEmail: null,
    });
    expect(again.already).toBe(true);

    const reactivated = await platformRepo.setStatus({
      tenantId: created.id,
      status: "active",
      reason: "Khách đã thanh toán đầy đủ",
      actorAccountId: adminId,
      actorEmail: null,
    });
    expect(reactivated).toMatchObject({ status: "active", already: false });

    const audit = await handle.db
      .select({ action: auditLogs.action, payload: auditLogs.payload })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.tenantId, created.id),
          inArray(auditLogs.action, ["platform.tenant_suspended", "platform.tenant_activated"]),
        ),
      );
    expect(audit).toHaveLength(2); // one per real change, none for the no-op
    for (const row of audit) {
      expect(String((row.payload as { reason?: unknown }).reason ?? "")).not.toHaveLength(0);
    }
  });

  it("404s an unknown tenant on the status switch", async () => {
    await expect(
      platformRepo.setStatus({
        tenantId: testTenantId(randomUUID()),
        status: "suspended",
        reason: "Không tồn tại nhưng vẫn phải có lý do",
        actorAccountId: adminId,
        actorEmail: null,
      }),
    ).rejects.toMatchObject({ code: "TENANT_NOT_FOUND" });
  });
});
