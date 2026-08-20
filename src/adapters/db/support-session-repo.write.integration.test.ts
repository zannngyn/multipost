import { randomUUID } from "node:crypto";

import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { testTenantId } from "@/core/domain/tenant-context.testing";
import type { LogBindings, Logger } from "@/core/ports/infra";

import { makeGlobalIdentityTestLock } from "./__fixtures__/global-identity-lock";
import { makeDbHandle } from "./client";
import { DrizzleSupportSessionRepo } from "./support-session-repo.drizzle";
import { accounts, auditLogs, platformAccessSessions, tenants } from "./schema";

/**
 * M3.3 — support-mode sessions on real Postgres, the full audited loop:
 * open books the ENTRY under the target tenant (with the purpose), the fresh
 * liveness read serves — and dies on — exactly the right conditions, a new
 * visit revokes (and books the exit of) the old one, and close is idempotent.
 *
 * Self-sufficient by construction (the M3.2 lesson): every tenant/account this
 * file touches is minted here — it must stay green on a COMPLETELY BLANK
 * database.
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

describe.skipIf(!url)("DrizzleSupportSessionRepo — the write path", () => {
  const handle = makeDbHandle({ url: url ?? "postgres://unused", maxPoolSize: 3 });
  const repo = new DrizzleSupportSessionRepo(handle.db, { logger: silentLogger() });

  // Creates account rows (global table) — serialise with the other files.
  const globalLock = makeGlobalIdentityTestLock(url ?? "postgres://unused");

  const suffix = randomUUID().slice(0, 8);
  const tenantA = testTenantId(randomUUID());
  const tenantB = testTenantId(randomUUID());
  let staffId = "";
  const NOW = new Date();
  const LATER = new Date(NOW.getTime() + 60 * 60 * 1000);

  beforeAll(async () => {
    await globalLock.acquire();
    await handle.db.insert(tenants).values([
      { id: tenantA, name: `Khách A ${suffix}`, status: "active" },
      { id: tenantB, name: `Khách B ${suffix}`, status: "active" },
    ]);
    const rows = await handle.db
      .insert(accounts)
      .values({ displayName: `Staff ${suffix}` })
      .returning({ id: accounts.id });
    staffId = rows[0].id;
  });

  afterAll(async () => {
    for (const table of [auditLogs, platformAccessSessions] as const) {
      await handle.db.delete(table).where(inArray(table.tenantId, [tenantA, tenantB]));
    }
    await handle.db.delete(tenants).where(inArray(tenants.id, [tenantA, tenantB]));
    await handle.db.delete(accounts).where(eq(accounts.id, staffId));
    await globalLock.release();
    await handle.close();
  });

  const open = (tenantId = tenantA, purpose = `Điều tra lỗi sync theo ticket ${suffix}`) =>
    repo.open({
      accountId: staffId,
      tenantId,
      purpose,
      expiresAt: LATER,
      now: new Date(),
      actorEmail: `staff-${suffix}@mysp.vn`,
    });

  const auditActions = async (tenantId: string) =>
    handle.db
      .select({ action: auditLogs.action, payload: auditLogs.payload, actorKind: auditLogs.actorKind })
      .from(auditLogs)
      .where(eq(auditLogs.tenantId, tenantId));

  // --- Edge cases first -------------------------------------------------------

  it("404s an unknown tenant and a suspended one — support enters living companies only", async () => {
    await expect(open(testTenantId(randomUUID()))).rejects.toMatchObject({
      code: "TENANT_NOT_FOUND",
    });

    await handle.db.update(tenants).set({ status: "suspended" }).where(eq(tenants.id, tenantB));
    await expect(open(tenantB)).rejects.toMatchObject({ code: "TENANT_NOT_FOUND" });
    await handle.db.update(tenants).set({ status: "active" }).where(eq(tenants.id, tenantB));
  });

  // --- The audited loop -------------------------------------------------------

  it("open books the ENTRY under the target tenant, purpose included, actor_kind platform_support", async () => {
    const opened = await open();

    const audit = await auditActions(tenantA);
    const entered = audit.filter((row) => row.action === "platform.entered_tenant");
    expect(entered).toHaveLength(1);
    expect(entered[0].actorKind).toBe("platform_support");
    expect(entered[0].payload).toMatchObject({
      purpose: `Điều tra lỗi sync theo ticket ${suffix}`,
      actor_account_id: staffId,
    });

    // ...and the visit is immediately live.
    const live = await repo.findLive(opened.sessionId, staffId, new Date());
    expect(live).toMatchObject({ tenantId: tenantA, tenantName: `Khách A ${suffix}` });
  });

  it("findLive refuses: wrong account, expired, revoked", async () => {
    const opened = await open();

    await expect(repo.findLive(opened.sessionId, randomUUID(), new Date())).resolves.toBeNull();
    await expect(
      repo.findLive(opened.sessionId, staffId, new Date(LATER.getTime() + 1)),
    ).resolves.toBeNull();

    await repo.close({
      sessionId: opened.sessionId,
      accountId: staffId,
      now: new Date(),
      actorEmail: null,
    });
    await expect(repo.findLive(opened.sessionId, staffId, new Date())).resolves.toBeNull();
  });

  it("opening a NEW visit revokes the old one and books ITS exit — one at a time, never nested", async () => {
    const first = await open(tenantA);
    const second = await open(tenantB, `Chuyển sang hỗ trợ khách B ${suffix}`);

    // The old visit is dead the moment the new one exists.
    await expect(repo.findLive(first.sessionId, staffId, new Date())).resolves.toBeNull();
    await expect(repo.findLive(second.sessionId, staffId, new Date())).resolves.toMatchObject({
      tenantId: tenantB,
    });

    // Tenant A's book shows the departure, reasoned.
    const auditA = await auditActions(tenantA);
    const exited = auditA.filter(
      (row) =>
        row.action === "platform.exited_tenant" &&
        (row.payload as { reason?: string }).reason === "REPLACED_BY_NEW_SESSION",
    );
    expect(exited.length).toBeGreaterThanOrEqual(1);
  });

  it("close is idempotent: one exit audit, repeat closes report already_closed", async () => {
    const opened = await open();
    const before = (await auditActions(tenantA)).filter(
      (row) => row.action === "platform.exited_tenant",
    ).length;

    await expect(
      repo.close({ sessionId: opened.sessionId, accountId: staffId, now: new Date(), actorEmail: null }),
    ).resolves.toBe("closed");
    await expect(
      repo.close({ sessionId: opened.sessionId, accountId: staffId, now: new Date(), actorEmail: null }),
    ).resolves.toBe("already_closed");
    await expect(
      repo.close({ sessionId: randomUUID(), accountId: staffId, now: new Date(), actorEmail: null }),
    ).resolves.toBe("not_found");

    const after = (await auditActions(tenantA)).filter(
      (row) => row.action === "platform.exited_tenant",
    ).length;
    expect(after).toBe(before + 1); // exactly ONE exit line for the double close
  });

  it("nothing can extend a visit: the row's expires_at is written once", async () => {
    const opened = await open();
    const rows = await handle.db
      .select({ expiresAt: platformAccessSessions.expiresAt })
      .from(platformAccessSessions)
      .where(
        and(
          eq(platformAccessSessions.id, opened.sessionId),
          eq(platformAccessSessions.accountId, staffId),
        ),
      );
    // The repo exposes open/findLive/close only — this pins the DATA half: the
    // stored expiry equals what open wrote, and no API surface mutates it.
    expect(rows[0].expiresAt).toEqual(LATER);
  });
});
