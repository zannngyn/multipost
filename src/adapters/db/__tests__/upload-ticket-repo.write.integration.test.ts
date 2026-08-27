import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { testTenantId } from "@/core/domain/tenant-context.testing";
import type { UploadTicket } from "@/core/ports/upload-ticket-repo";

import { makeDbHandle } from "../client";
import { tenants, uploadTickets } from "../schema";
import { DrizzleUploadTicketRepo } from "../upload-ticket-repo.drizzle";

/**
 * The write path for `upload_ticket` — see the schema comment for why the
 * table is separate from `media_asset`. Tenant isolation on `findMany` is the
 * load-bearing behaviour: a ticket of another tenant must be INVISIBLE, not
 * merely absent from a filtered list.
 *
 * Runs only when TEST_DATABASE_URL points at a MIGRATED database:
 *   TEST_DATABASE_URL=postgres://... pnpm vitest run src/adapters/db/upload-ticket-repo.write.integration.test.ts
 */

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("DrizzleUploadTicketRepo", () => {
  const handle = makeDbHandle({ url: url ?? "postgres://unused", maxPoolSize: 3 });
  const repo = new DrizzleUploadTicketRepo(handle.db);

  const TENANT = testTenantId(randomUUID());
  const OTHER = testTenantId(randomUUID());

  const ticket = (
    assetId: string,
    tenantId = TENANT,
    expiresAt = new Date(Date.now() + 60_000),
  ): UploadTicket => ({
    tenantId,
    assetId,
    storageKey: `${tenantId}/${assetId}`,
    fileName: `${assetId}.jpg`,
    declaredMime: "image/jpeg",
    declaredSize: 100,
    productCode: "MG0AD6112",
    expiresAt,
  });

  beforeAll(async () => {
    await handle.db.insert(tenants).values([
      { id: TENANT, name: `upload-ticket test ${TENANT}`, status: "active" },
      { id: OTHER, name: `upload-ticket test ${OTHER}`, status: "active" },
    ]);
  });

  afterAll(async () => {
    await handle.db.delete(uploadTickets).where(eq(uploadTickets.tenantId, TENANT));
    await handle.db.delete(uploadTickets).where(eq(uploadTickets.tenantId, OTHER));
    await handle.db.delete(tenants).where(eq(tenants.id, TENANT));
    await handle.db.delete(tenants).where(eq(tenants.id, OTHER));
    await handle.close();
  });

  it("creates tickets and finds them again", async () => {
    expect(await repo.createMany(TENANT, [ticket("t1"), ticket("t2")])).toBe(2);

    const found = await repo.findMany(TENANT, ["t1", "t2"]);
    expect(found.map((t) => t.assetId).sort()).toEqual(["t1", "t2"]);
  });

  it("never returns a ticket of another tenant", async () => {
    await repo.createMany(OTHER, [ticket("t3", OTHER)]);
    expect(await repo.findMany(TENANT, ["t3"])).toHaveLength(0);
  });

  it("deleteMany only removes rows of its own tenant", async () => {
    expect(await repo.deleteMany(TENANT, ["t3"])).toBe(0);
    expect(await repo.deleteMany(TENANT, ["t1"])).toBe(1);
  });

  it("listExpired returns only tickets past their expiry", async () => {
    await repo.createMany(TENANT, [ticket("t4", TENANT, new Date(Date.now() - 60_000))]);

    const expired = await repo.listExpired({ now: new Date(), limit: 50 });
    expect(expired.map((t) => t.assetId)).toContain("t4");
    expect(expired.map((t) => t.assetId)).not.toContain("t2");
  });

  it("listExpired orders oldest expiry first, so a limited pass cannot starve older rows behind a repeat offender", async () => {
    const base = Date.now() - 10 * 60_000;
    await repo.createMany(TENANT, [
      ticket("t7-newer", TENANT, new Date(base + 2_000)),
      ticket("t6-oldest", TENANT, new Date(base)),
      ticket("t8-middle", TENANT, new Date(base + 1_000)),
    ]);

    const expired = await repo.listExpired({ now: new Date(), limit: 50 });
    const ours = expired.filter((t) => ["t6-oldest", "t7-newer", "t8-middle"].includes(t.assetId));
    expect(ours.map((t) => t.assetId)).toEqual(["t6-oldest", "t8-middle", "t7-newer"]);
  });

  it("findMany returns empty for an empty list without touching the DB", async () => {
    expect(await repo.findMany(TENANT, [])).toEqual([]);
  });

  it("rejects a duplicate (tenant, asset) insert — a retried createMany must fail loudly, not double the row", async () => {
    await repo.createMany(TENANT, [ticket("t5")]);
    await expect(repo.createMany(TENANT, [ticket("t5")])).rejects.toMatchObject({ code: "DB_ERROR" });
  });

  it("still accepts the same asset id under a DIFFERENT tenant — the constraint must not become a cross-tenant collision", async () => {
    expect(await repo.createMany(OTHER, [ticket("t5", OTHER)])).toBe(1);
  });
});
