import { describe, expect, it } from "vitest";

import type { Clock } from "@/core/ports/infra";
import type { UserRepo } from "@/core/ports/user-repo";

import {
  accessRow,
  makeFakeAccessRepo,
  silentLogger,
  TEST_TENANT,
} from "../__fixtures__/access-request-repo";
import { makeManageAccessRequests } from "../manage-access-requests";
import { testTenantId } from "@/core/domain/tenant-context.testing";

/** E1.4 — the approval screen: list, approve with a role, block. */

const NOW = new Date("2026-08-19T05:00:00.000Z");

function clock(): Clock {
  return { now: () => NOW, nowMs: () => NOW.getTime() };
}

function harness(seed = [accessRow()]) {
  const requests = makeFakeAccessRepo(seed);
  const users: UserRepo = {
    findUserIdByEmail: async () => "admin-user-id",
    // This usecase names its actor by e-mail; the account arm exists only to
    // satisfy the port (added for draft ownership, doc 10 §4.2).
    findUserIdByAccount: async () => null,
  };
  const usecase = makeManageAccessRequests({
    requests,
    clock: clock(),
    logger: silentLogger(),
    users,
  });
  return { usecase, requests };
}

// --- Edge cases first -------------------------------------------------------

describe("decideAccessRequest — refusals", () => {
  it("refuses an unknown decision", async () => {
    const { usecase } = harness();
    await expect(
      usecase.decideAccessRequest({
        tenantId: TEST_TENANT,
        id: "req-seed",
        decision: "maybe" as never,
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("refuses an approval with no role — before writing anything", async () => {
    const { usecase, requests } = harness();
    await expect(
      usecase.decideAccessRequest({
        tenantId: TEST_TENANT,
        id: "req-seed",
        decision: "approve",
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(requests.rows()[0].status).toBe("pending");
  });

  it("refuses an approval with a role that is not in the enum", async () => {
    const { usecase } = harness();
    await expect(
      usecase.decideAccessRequest({
        tenantId: TEST_TENANT,
        id: "req-seed",
        decision: "approve",
        role: "superuser",
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("answers ACCESS_REQUEST_NOT_FOUND for an id this tenant does not have", async () => {
    const { usecase } = harness();
    await expect(
      usecase.decideAccessRequest({
        tenantId: TEST_TENANT,
        id: "req-missing",
        decision: "block",
      }),
    ).rejects.toMatchObject({ code: "ACCESS_REQUEST_NOT_FOUND" });
  });

  it("refuses a malformed tenant id", async () => {
    const { usecase } = harness();
    await expect(
      usecase.decideAccessRequest({ tenantId: testTenantId("nope"), id: "req-seed", decision: "block" }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});

// --- Decisions --------------------------------------------------------------

describe("decideAccessRequest — happy paths", () => {
  it("approves with a role and records who decided", async () => {
    const { usecase, requests } = harness();

    const result = await usecase.decideAccessRequest({
      tenantId: TEST_TENANT,
      id: "req-seed",
      decision: "approve",
      role: "editor",
      actorEmail: "Boss@MYSP.VN",
    });

    expect(result).toEqual({ id: "req-seed", status: "approved", role: "editor" });
    const row = requests.rows()[0];
    expect(row.decidedAt).toEqual(NOW);
    expect(row.decidedByEmail).toBe("boss@mysp.vn");
  });

  it("is idempotent: approving twice keeps the identity approved", async () => {
    const { usecase, requests } = harness();
    await usecase.decideAccessRequest({
      tenantId: TEST_TENANT,
      id: "req-seed",
      decision: "approve",
      role: "viewer",
    });
    const second = await usecase.decideAccessRequest({
      tenantId: TEST_TENANT,
      id: "req-seed",
      decision: "approve",
      role: "admin",
    });

    expect(second.status).toBe("approved");
    expect(second.role).toBe("admin");
    expect(requests.rows()).toHaveLength(1);
  });

  it("blocks an already approved operator", async () => {
    const { usecase } = harness([accessRow({ status: "approved", role: "editor" })]);
    const result = await usecase.decideAccessRequest({
      tenantId: TEST_TENANT,
      id: "req-seed",
      decision: "block",
    });
    expect(result.status).toBe("blocked");
  });
});

// --- Listing ----------------------------------------------------------------

describe("listAccessRequests", () => {
  it("defaults to pending", async () => {
    const { usecase } = harness([
      accessRow({ id: "req-1", status: "pending" }),
      accessRow({ id: "req-2", providerAccountId: "2", status: "approved" }),
    ]);
    const items = await usecase.listAccessRequests({ tenantId: TEST_TENANT });
    expect(items.map((item) => item.id)).toEqual(["req-1"]);
  });

  it("returns every row for `all`, newest request first, with ISO dates", async () => {
    const { usecase } = harness([
      accessRow({ id: "req-old", requestedAt: new Date("2026-08-18T00:00:00.000Z") }),
      accessRow({
        id: "req-new",
        providerAccountId: "2",
        status: "approved",
        role: "editor",
        requestedAt: new Date("2026-08-19T00:00:00.000Z"),
      }),
    ]);

    const items = await usecase.listAccessRequests({ tenantId: TEST_TENANT, status: "all" });

    expect(items.map((item) => item.id)).toEqual(["req-new", "req-old"]);
    expect(items[0].requestedAt).toBe("2026-08-19T00:00:00.000Z");
    expect(items[0].email).toBeNull();
  });

  it("refuses an unknown filter instead of silently listing everything", async () => {
    const { usecase } = harness();
    await expect(
      usecase.listAccessRequests({ tenantId: TEST_TENANT, status: "whatever" as never }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("never exposes the session address of an identity", async () => {
    const { usecase } = harness();
    const [item] = await usecase.listAccessRequests({ tenantId: TEST_TENANT });
    expect(Object.keys(item)).not.toContain("sessionEmail");
  });
});
