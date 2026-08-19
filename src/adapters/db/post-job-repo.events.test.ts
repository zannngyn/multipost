import { describe, expect, it } from "vitest";

import type { Database } from "./client";
import { DrizzlePostJobRepo } from "./post-job-repo.drizzle";

/**
 * E7.5 — the guards of `appendJobEvent`, which run BEFORE the driver is touched
 * (so this needs no database). What they protect: a milestone row with no
 * tenant, no job or no stage would be an untraceable row in an append-only
 * table nobody can clean up (business rule 7 + design §5.4).
 *
 * The INSERT itself is covered by the gated integration suite and by the smoke
 * script against a real Postgres.
 */

const TENANT = "00000000-0000-0000-0000-000000000001";
const NEVER_TOUCHED = {} as Database;

function repo(): DrizzlePostJobRepo {
  return new DrizzlePostJobRepo(NEVER_TOUCHED);
}

describe("appendJobEvent — refused before the driver is reached", () => {
  it("refuses a tenant id that is not a UUID", async () => {
    await expect(
      repo().appendJobEvent({
        tenantId: "not-a-tenant",
        postJobId: "job-1",
        batchId: "batch-1",
        stage: "checking_stock",
        attempt: 1,
        occurredAt: new Date(),
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it.each([
    ["a blank post job id", { postJobId: "  " }],
    ["a blank batch id", { batchId: "" }],
    ["a blank stage", { stage: "  " as never }],
  ])("refuses %s", async (_label, patch) => {
    await expect(
      repo().appendJobEvent({
        tenantId: TENANT,
        postJobId: "job-1",
        batchId: "batch-1",
        stage: "checking_stock",
        attempt: 1,
        occurredAt: new Date(),
        ...patch,
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});
