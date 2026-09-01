import { describe, expect, it, vi } from "vitest";

import type { LogBindings, Logger } from "@/core/ports/infra";

import type { Database } from "../client";
import { DrizzlePlatformTenantRepo } from "../platform-tenant-repo.drizzle";

/**
 * `listTenants` without a database: the query builder is stubbed and the test
 * feeds it the rows a LEFT JOIN really produces — including the shape a tenant
 * with NO `tenant_profile` row comes back as (every joined column null).
 *
 * What is under test is the MAPPING, and it is the place the survey's three
 * states can be destroyed:
 *   - no joined row  -> `survey: null` (never started), tenant still listed;
 *   - `[]`           -> `[]` ("none of these"), never degraded to null;
 *   - null column    -> null (skipped), never degraded to `[]`.
 * A corrupt stored value is the fourth case: reported as `null` with a WARN
 * naming the tenant, because one bad row must not take the whole platform
 * list — every customer of MYSP — down with it.
 */

const TENANT = "00000000-0000-0000-0000-00000000d00d";
const OTHER = "00000000-0000-0000-0000-00000000beef";

type JoinedRow = Record<string, unknown>;

function baseRow(over: JoinedRow = {}): JoinedRow {
  return {
    id: TENANT,
    name: "Khách A",
    slug: "khach-a",
    plan: "standard",
    status: "active",
    createdAt: new Date("2026-08-21T05:00:00.000Z"),
    memberCount: 2,
    // LEFT JOIN miss: every tenant_profile column arrives null.
    profileTenantId: null,
    sellerKind: null,
    currentTools: null,
    channelCount: null,
    focusChannels: null,
    surveyCompletedAt: null,
    ...over,
  };
}

function stubDb(rows: JoinedRow[]) {
  const groupBy = vi.fn(() => ({ orderBy: async () => rows }));
  const leftJoin = vi.fn();
  const chain = {
    leftJoin: (...args: unknown[]) => {
      leftJoin(...args);
      return chain;
    },
    groupBy,
  };
  const db = { select: () => ({ from: () => chain }) } as unknown as Database;
  return { db, groupBy, leftJoin };
}

function recordingLogger() {
  const warn = vi.fn();
  const logger: Logger = {
    child: (_b: LogBindings) => logger,
    debug: () => {},
    info: () => {},
    warn,
    error: () => {},
  };
  return { logger, warn };
}

function repo(rows: JoinedRow[]) {
  const { db, groupBy, leftJoin } = stubDb(rows);
  const { logger, warn } = recordingLogger();
  return { repo: new DrizzlePlatformTenantRepo(db, { logger }), warn, groupBy, leftJoin };
}

// --- Edge cases first --------------------------------------------------------

describe("listTenants — tenants without a survey row", () => {
  it("keeps a tenant that never answered, with survey null", async () => {
    const { repo: subject } = repo([baseRow()]);
    const items = await subject.listTenants();

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: TENANT, memberCount: 2 });
    // null = never started. NOT an object of nulls, and definitely not dropped.
    expect(items[0].survey).toBeNull();
  });

  it("lists a tenant with no survey next to one with answers — the JOIN is OUTWARD", async () => {
    const { repo: subject } = repo([
      baseRow(),
      baseRow({
        id: OTHER,
        profileTenantId: OTHER,
        sellerKind: "agency",
        currentTools: [],
        channelCount: "4-6",
        focusChannels: ["tiktok"],
        surveyCompletedAt: new Date("2026-08-26T10:00:00.000Z"),
      }),
    ]);

    const items = await subject.listTenants();
    expect(items.map((item) => item.id)).toEqual([TENANT, OTHER]);
    expect(items[0].survey).toBeNull();
    expect(items[1].survey).toEqual({
      sellerKind: "agency",
      currentTools: [],
      channelCount: "4-6",
      focusChannels: ["tiktok"],
      completedAt: new Date("2026-08-26T10:00:00.000Z"),
    });
  });
});

describe("listTenants — the three states survive the mapping", () => {
  it("keeps [] as [] and null as null in the same row", async () => {
    const { repo: subject } = repo([
      baseRow({
        profileTenantId: TENANT,
        sellerKind: null,
        currentTools: [],
        focusChannels: null,
      }),
    ]);

    const survey = (await subject.listTenants())[0].survey;
    // "Không chọn gì" and "chưa trả lời" are different answers about the same
    // tenant; a mapper that normalises either way makes the aggregate lie.
    expect(survey?.currentTools).toEqual([]);
    expect(survey?.focusChannels).toBeNull();
    expect(survey?.sellerKind).toBeNull();
  });

  it("does not invent an empty row for a profile that exists but is all null", async () => {
    const { repo: subject } = repo([baseRow({ profileTenantId: TENANT })]);
    const survey = (await subject.listTenants())[0].survey;

    // A row exists (the survey was started), so it is an object of nulls —
    // distinct from `survey: null`, which means no row at all.
    expect(survey).toEqual({
      sellerKind: null,
      currentTools: null,
      channelCount: null,
      focusChannels: null,
      completedAt: null,
    });
  });
});

describe("listTenants — unreadable stored values", () => {
  it("reports a corrupt survey as null, warns with the tenant id, and keeps the tenant", async () => {
    const { repo: subject, warn } = repo([
      baseRow({ profileTenantId: TENANT, sellerKind: "   " }),
      baseRow({ id: OTHER, profileTenantId: OTHER, focusChannels: "tiktok" }),
    ]);

    const items = await subject.listTenants();
    expect(items).toHaveLength(2);
    expect(items[0].survey).toBeNull();
    expect(items[1].survey).toBeNull();
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0][1]).toMatchObject({
      tenant_id: TENANT,
      reason: "UNREADABLE_PROFILE_ROW",
    });
  });

  it("does not swallow a driver failure as an empty platform", async () => {
    const { logger } = recordingLogger();
    const db = {
      select: () => ({
        from: () => ({
          leftJoin() {
            return this;
          },
          groupBy: () => ({
            orderBy: async () => {
              throw new Error("connection terminated");
            },
          }),
        }),
      }),
    } as unknown as Database;

    await expect(new DrizzlePlatformTenantRepo(db, { logger }).listTenants()).rejects.toMatchObject({
      code: "DB_ERROR",
    });
  });
});

describe("listTenants — the query", () => {
  it("groups by both primary keys so the join cannot multiply the member count", async () => {
    const { repo: subject, groupBy, leftJoin } = repo([baseRow()]);
    await subject.listTenants();

    // memberships + tenant_profile: two OUTER joins, never inner.
    expect(leftJoin).toHaveBeenCalledTimes(2);
    expect(groupBy).toHaveBeenCalledTimes(1);
    expect(groupBy.mock.calls[0]).toHaveLength(2);
  });
});
