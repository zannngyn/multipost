import { describe, expect, it } from "vitest";

import { testTenantId } from "@/core/domain/tenant-context.testing";

import type { Database } from "./client";
import { DrizzleTenantProfileRepo } from "./tenant-profile-repo.drizzle";

/**
 * The onboarding survey profile, without a database: the query builder is
 * stubbed but it SIMULATES postgres upsert semantics (insert when absent, merge
 * the `set` object when present). That is deliberate — the whole contract of
 * this repo is which keys end up in `set`, and a stub that only records the call
 * would let "upsert overwrites everything" pass.
 *
 * The distinction under test everywhere below: `undefined` = leave alone,
 * `null` = the operator pressed "Bỏ qua", `[]` = the operator answered "none of
 * these". Three different answers, three different stored values.
 */

const TENANT = testTenantId("00000000-0000-0000-0000-000000000001");

type StoredRow = Record<string, unknown>;

interface UpsertCall {
  values: StoredRow;
  set: StoredRow;
}

const EMPTY_ROW: StoredRow = {
  tenantId: TENANT,
  sellerKind: null,
  currentTools: null,
  channelCount: null,
  focusChannels: null,
  completedAt: null,
  createdAt: new Date("2026-08-26T00:00:00.000Z"),
  updatedAt: new Date("2026-08-26T00:00:00.000Z"),
};

function stubDb(initial: StoredRow | null) {
  let stored: StoredRow | null = initial ? { ...EMPTY_ROW, ...initial } : null;
  const calls: UpsertCall[] = [];

  const db = {
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => (stored ? [stored] : []) }) }),
    }),
    insert: () => ({
      values: (values: StoredRow) => ({
        onConflictDoUpdate: ({ set }: { set: StoredRow }) => ({
          returning: async () => {
            calls.push({ values, set });
            // Postgres semantics: conflict -> apply `set` to the stored row;
            // no conflict -> the row is what `values` says, defaults elsewhere.
            stored = stored ? { ...stored, ...set } : { ...EMPTY_ROW, ...values };
            return [stored];
          },
        }),
      }),
    }),
  } as unknown as Database;

  return { db, calls, peek: () => stored };
}

function failingDb(error: unknown): Database {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => {
            throw error;
          },
        }),
      }),
    }),
    insert: () => ({
      values: () => ({
        onConflictDoUpdate: () => ({
          returning: async () => {
            throw error;
          },
        }),
      }),
    }),
  } as unknown as Database;
}

describe("get — reading a profile that may not exist", () => {
  it("returns null when the tenant has never answered anything", async () => {
    const { db } = stubDb(null);
    expect(await new DrizzleTenantProfileRepo(db).get(TENANT)).toBeNull();
  });

  it("refuses a tenant id that is not a uuid instead of querying with garbage", async () => {
    const { db } = stubDb(null);
    await expect(
      new DrizzleTenantProfileRepo(db).get(testTenantId("not-a-uuid")),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("wraps a driver failure as DB_ERROR carrying the operation and tenant", async () => {
    const repo = new DrizzleTenantProfileRepo(failingDb(new Error("connection reset")));
    await expect(repo.get(TENANT)).rejects.toMatchObject({
      code: "DB_ERROR",
      context: expect.objectContaining({ operation: "tenantProfile.get", tenant_id: TENANT }),
    });
  });

  it("reads back every answer, unfinished onboarding included", async () => {
    const { db } = stubDb({
      sellerKind: "solo_seller",
      currentTools: ["meta_business_suite", "ai_platform"],
      channelCount: "4-6",
      focusChannels: ["facebook"],
      completedAt: null,
    });

    expect(await new DrizzleTenantProfileRepo(db).get(TENANT)).toEqual({
      sellerKind: "solo_seller",
      currentTools: ["meta_business_suite", "ai_platform"],
      channelCount: "4-6",
      focusChannels: ["facebook"],
      completedAt: null,
    });
  });
});

describe("upsert — rejects at the boundary before it writes", () => {
  it("refuses an empty patch rather than writing a row that says nothing", async () => {
    const { db, calls } = stubDb(null);
    await expect(new DrizzleTenantProfileRepo(db).upsert(TENANT, {})).rejects.toMatchObject({
      code: "INVALID_INPUT",
      context: expect.objectContaining({ field: "patch" }),
    });
    expect(calls).toHaveLength(0);
  });

  it.each([
    ["an empty string answer", { sellerKind: "" }],
    ["a whitespace-only answer", { channelCount: "   " }],
    ["an empty string inside an array", { currentTools: ["meta_business_suite", ""] }],
    ["a non-string answer", { sellerKind: 42 as unknown as string }],
    ["a non-array multi answer", { focusChannels: "facebook" as unknown as string[] }],
  ])("refuses %s — blank means null, and null is spelled null", async (_label, patch) => {
    const { db, calls } = stubDb(null);
    await expect(new DrizzleTenantProfileRepo(db).upsert(TENANT, patch)).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    expect(calls).toHaveLength(0);
  });

  it("refuses a key nobody asked for instead of dropping it silently", async () => {
    const { db } = stubDb(null);
    await expect(
      new DrizzleTenantProfileRepo(db).upsert(TENANT, {
        sellerKind: "solo_seller",
        favouriteColour: "blue",
      } as never),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("wraps a driver failure as DB_ERROR", async () => {
    const repo = new DrizzleTenantProfileRepo(failingDb(new Error("deadlock detected")));
    await expect(repo.upsert(TENANT, { sellerKind: "solo_seller" })).rejects.toMatchObject({
      code: "DB_ERROR",
      context: expect.objectContaining({ operation: "tenantProfile.upsert" }),
    });
  });
});

describe("upsert — undefined keeps, null clears", () => {
  it("creates the row on the first answer with the other columns left null", async () => {
    const { db, calls } = stubDb(null);
    const profile = await new DrizzleTenantProfileRepo(db).upsert(TENANT, {
      sellerKind: "solo_seller",
    });

    expect(profile).toEqual({
      sellerKind: "solo_seller",
      currentTools: null,
      channelCount: null,
      focusChannels: null,
      completedAt: null,
    });
    expect(calls[0]?.values).toMatchObject({ tenantId: TENANT, sellerKind: "solo_seller" });
  });

  it("does NOT touch a column the patch left out", async () => {
    const { db, calls } = stubDb({ currentTools: ["meta_business_suite"], channelCount: "4-6" });

    const profile = await new DrizzleTenantProfileRepo(db).upsert(TENANT, {
      sellerKind: "shop_owner",
    });

    expect(profile.currentTools).toEqual(["meta_business_suite"]);
    expect(profile.channelCount).toBe("4-6");
    // The proof: an absent key must not reach the UPDATE at all.
    expect(Object.keys(calls[0]?.set ?? {})).not.toContain("currentTools");
    expect(Object.keys(calls[0]?.set ?? {})).not.toContain("channelCount");
  });

  it("clears the column when the patch says null — 'Bỏ qua' is an answer", async () => {
    const { db, calls } = stubDb({ sellerKind: "solo_seller", channelCount: "4-6" });

    const profile = await new DrizzleTenantProfileRepo(db).upsert(TENANT, { sellerKind: null });

    expect(profile.sellerKind).toBeNull();
    expect(calls[0]?.set).toHaveProperty("sellerKind", null);
    // Untouched neighbour, same call: null is targeted, not a wipe.
    expect(profile.channelCount).toBe("4-6");
  });

  it("treats an explicitly-undefined key as absent, not as a clear", async () => {
    const { db, calls } = stubDb({ sellerKind: "solo_seller" });

    const profile = await new DrizzleTenantProfileRepo(db).upsert(TENANT, {
      sellerKind: undefined,
      channelCount: "7-10",
    });

    expect(profile.sellerKind).toBe("solo_seller");
    expect(Object.keys(calls[0]?.set ?? {})).not.toContain("sellerKind");
  });

  it("stamps completedAt when the flow finishes, and can clear it again", async () => {
    const finishedAt = new Date("2026-08-26T09:30:00.000Z");
    const { db } = stubDb({ sellerKind: "solo_seller" });
    const repo = new DrizzleTenantProfileRepo(db);

    expect((await repo.upsert(TENANT, { completedAt: finishedAt })).completedAt).toEqual(finishedAt);
    expect((await repo.upsert(TENANT, { completedAt: null })).completedAt).toBeNull();
  });
});

describe("upsert — an empty array is an answer, not an absence", () => {
  it("stores [] and reads it back as [], never as null", async () => {
    const { db, calls } = stubDb(null);
    const repo = new DrizzleTenantProfileRepo(db);

    const written = await repo.upsert(TENANT, { currentTools: [] });
    expect(written.currentTools).toEqual([]);
    expect(written.currentTools).not.toBeNull();
    expect(calls[0]?.values).toHaveProperty("currentTools", []);

    const read = await repo.get(TENANT);
    expect(read?.currentTools).toEqual([]);
    expect(read?.currentTools).not.toBeNull();
  });

  it("keeps [] and null apart on the same column across two writes", async () => {
    const { db } = stubDb(null);
    const repo = new DrizzleTenantProfileRepo(db);

    expect((await repo.upsert(TENANT, { focusChannels: [] })).focusChannels).toEqual([]);
    expect((await repo.upsert(TENANT, { focusChannels: null })).focusChannels).toBeNull();
    expect((await repo.upsert(TENANT, { focusChannels: ["facebook"] })).focusChannels).toEqual([
      "facebook",
    ]);
  });

  it("reads a stored null array as null — 'chưa hỏi tới' is not 'không chọn gì'", async () => {
    const { db } = stubDb({ currentTools: null, focusChannels: [] });
    const profile = await new DrizzleTenantProfileRepo(db).get(TENANT);

    expect(profile?.currentTools).toBeNull();
    expect(profile?.focusChannels).toEqual([]);
  });
});
