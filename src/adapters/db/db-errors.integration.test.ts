import { afterAll, describe, expect, it } from "vitest";

import { AppError } from "@/core/domain/errors";

import { makeDbHandle } from "./client";
import { DrizzleMediaRepo } from "./media-repo.drizzle";
import { DrizzleProductRepo } from "./product-repo.drizzle";
import { DEMO_TENANT_ID } from "./seed-constants";
import { DrizzleSyncRunRepo } from "./sync-run-repo.drizzle";

/**
 * The 22P02 mapping against a REAL Postgres: only the server can decide that
 * 'not-a-uuid' is not a uuid, so a stubbed query builder would test nothing.
 *
 * Runs only when TEST_DATABASE_URL points at a MIGRATED database, so `pnpm
 * verify` stays green on a machine without Docker:
 *   TEST_DATABASE_URL=postgres://... pnpm test src/adapters/db/db-errors.integration.test.ts
 */

const url = process.env.TEST_DATABASE_URL;
const NOT_A_UUID = "not-a-uuid";

describe.skipIf(!url)("repos map Postgres 22P02 to INVALID_INPUT (real database)", () => {
  const handle = makeDbHandle({ url: url ?? "postgres://unused", maxPoolSize: 2 });
  const products = new DrizzleProductRepo(handle.db);
  const media = new DrizzleMediaRepo(handle.db);
  const syncRuns = new DrizzleSyncRunRepo(handle.db);

  afterAll(async () => {
    await handle.close();
  });

  it("product.deleteStale with a malformed syncRunId -> INVALID_INPUT, not DB_ERROR", async () => {
    const error = await products.deleteStale(DEMO_TENANT_ID, NOT_A_UUID).catch((e: unknown) => e);

    expect(AppError.is(error)).toBe(true);
    const appError = error as AppError;
    expect(appError.code).toBe("INVALID_INPUT");
    expect(appError.context).toMatchObject({
      operation: "product.deleteStale",
      field: "syncRunId",
      pg_code: "22P02",
      invalid_type: "uuid",
    });
    expect(appError.message).not.toContain(NOT_A_UUID);
  });

  it("media.deleteStale with a malformed syncRunId -> INVALID_INPUT", async () => {
    const error = await media.deleteStale(DEMO_TENANT_ID, NOT_A_UUID).catch((e: unknown) => e);

    expect((error as AppError).code).toBe("INVALID_INPUT");
    expect((error as AppError).context).toMatchObject({
      operation: "media.deleteStale",
      pg_code: "22P02",
    });
  });

  it("syncRun.finish with a malformed syncRunId -> INVALID_INPUT", async () => {
    const error = await syncRuns
      .finish({
        tenantId: DEMO_TENANT_ID,
        syncRunId: NOT_A_UUID,
        status: "succeeded",
        finishedAt: new Date(),
        counts: {
          driveFilesSeen: 0,
          mediaParsed: 0,
          mediaRejected: 0,
          mediaDuplicatesDropped: 0,
          mediaNeedingReview: 0,
          sheetRowsSeen: 0,
          productsParsed: 0,
          sheetRowsRejected: 0,
          productsWithConflict: 0,
          productsWithoutMedia: 0,
          mediaWithoutProduct: 0,
          productsWritten: 0,
          mediaWritten: 0,
          productsDeleted: 0,
          mediaDeleted: 0,
          issuesTotal: 0,
          issuesTruncated: false,
        },
        issues: [],
      })
      .catch((e: unknown) => e);

    expect((error as AppError).code).toBe("INVALID_INPUT");
    expect((error as AppError).context).toMatchObject({
      operation: "syncRun.finish",
      field: "syncRunId",
      pg_code: "22P02",
    });
  });

  it("a malformed TENANT id is still refused before any SQL is built", async () => {
    const error = await products.deleteStale(NOT_A_UUID, DEMO_TENANT_ID).catch((e: unknown) => e);
    expect((error as AppError).code).toBe("INVALID_INPUT");
    // Rejected by the tenant scope, so there is no SQLSTATE at all.
    expect((error as AppError).context).not.toHaveProperty("pg_code");
  });

  it("a well-formed uuid that matches nothing is NOT an error", async () => {
    await expect(
      products.deleteStale(DEMO_TENANT_ID, "00000000-0000-0000-0000-0000000000aa"),
    ).resolves.toBeTypeOf("number");
  });

  it("a genuine driver failure is still DB_ERROR (503)", async () => {
    const closed = makeDbHandle({ url: url ?? "postgres://unused", maxPoolSize: 1 });
    const repo = new DrizzleProductRepo(closed.db);
    await closed.close();

    const error = await repo.findByCode(DEMO_TENANT_ID, "MGKVX6310").catch((e: unknown) => e);
    expect((error as AppError).code).toBe("DB_ERROR");
  });
});
