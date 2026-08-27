import { describe, expect, it } from "vitest";

import { AppError } from "@/core/domain/errors";
import type { AccessRequestRepo } from "@/core/ports/access-request-repo";
import type { Clock } from "@/core/ports/infra";

import {
  accessRow,
  makeFakeAccessRepo,
  silentLogger,
  TEST_TENANT,
} from "../__fixtures__/access-request-repo";
import { makeCheckOperatorAccess } from "../check-operator-access";
import { testTenantId } from "@/core/domain/tenant-context.testing";

/** E1.4 — the sign-in gate and the per-request status read. */

const NOW = new Date("2026-08-19T04:00:00.000Z");

function clock(): Clock {
  return { now: () => NOW, nowMs: () => NOW.getTime() };
}

function harness(seed = [] as ReturnType<typeof accessRow>[]) {
  const requests = makeFakeAccessRepo(seed);
  const usecase = makeCheckOperatorAccess({ requests, clock: clock(), logger: silentLogger() });
  return { usecase, requests };
}

// --- Edge cases first -------------------------------------------------------

describe("registerAndCheck — refusals", () => {
  it("refuses a missing tenant id", async () => {
    const { usecase } = harness();
    await expect(
      usecase.registerAndCheck({
        tenantId: testTenantId("not-a-uuid"),
        provider: "facebook",
        providerAccountId: "1",
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("refuses an unsupported provider", async () => {
    const { usecase } = harness();
    await expect(
      usecase.registerAndCheck({
        tenantId: TEST_TENANT,
        provider: "github",
        providerAccountId: "1",
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("refuses Google without a usable e-mail — there would be no identity key", async () => {
    const { usecase } = harness();
    await expect(
      usecase.registerAndCheck({
        tenantId: TEST_TENANT,
        provider: "google",
        providerAccountId: "sub-1",
        email: null,
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("lets a repository failure through — a sign-in must not be waved past a broken registry", async () => {
    const requests: AccessRequestRepo = {
      ...makeFakeAccessRepo(),
      findByProviderAccount: async () => {
        throw new AppError("DB_ERROR", { message: "connection refused" });
      },
    };
    const usecase = makeCheckOperatorAccess({
      requests,
      clock: clock(),
      logger: silentLogger(),
    });

    await expect(
      usecase.registerAndCheck({
        tenantId: TEST_TENANT,
        provider: "facebook",
        providerAccountId: "1",
      }),
    ).rejects.toMatchObject({ code: "DB_ERROR" });
  });
});

// --- Recording a new identity ----------------------------------------------

describe("registerAndCheck — first sign-in", () => {
  it("records a Facebook identity with no e-mail as pending", async () => {
    const { usecase, requests } = harness();

    const state = await usecase.registerAndCheck({
      tenantId: TEST_TENANT,
      provider: "facebook",
      providerAccountId: "992710700450296",
      email: undefined,
      displayName: "Nguyen Van A",
    });

    expect(state).toEqual({ status: "pending", role: null, displayName: "Nguyen Van A" });
    const [row] = requests.rows();
    expect(row.email).toBeNull();
    expect(row.sessionEmail).toBe("fb-992710700450296@facebook.local");
    expect(row.requestedAt).toEqual(NOW);
  });

  it("stores an empty display name as null", async () => {
    const { usecase, requests } = harness();
    await usecase.registerAndCheck({
      tenantId: TEST_TENANT,
      provider: "facebook",
      providerAccountId: "1",
      displayName: "   ",
    });
    expect(requests.rows()[0].displayName).toBeNull();
  });

  it("keeps the same id under two providers as two identities", async () => {
    const { usecase, requests } = harness();
    await usecase.registerAndCheck({
      tenantId: TEST_TENANT,
      provider: "facebook",
      providerAccountId: "12345",
    });
    await usecase.registerAndCheck({
      tenantId: TEST_TENANT,
      provider: "google",
      providerAccountId: "12345",
      email: "a@gmail.com",
    });

    expect(requests.rows()).toHaveLength(2);
    expect(new Set(requests.rows().map((row) => row.sessionEmail)).size).toBe(2);
  });

  it("does not create a second row when the same identity signs in again", async () => {
    const { usecase, requests } = harness();
    const input = {
      tenantId: TEST_TENANT,
      provider: "facebook" as const,
      providerAccountId: "992710700450296",
    };
    await usecase.registerAndCheck(input);
    await usecase.registerAndCheck(input);
    expect(requests.rows()).toHaveLength(1);
  });

  it("reports blocked without touching the row", async () => {
    const { usecase, requests } = harness([accessRow({ status: "blocked" })]);
    const state = await usecase.registerAndCheck({
      tenantId: TEST_TENANT,
      provider: "facebook",
      providerAccountId: "992710700450296",
    });
    expect(state.status).toBe("blocked");
    expect(requests.rows()).toHaveLength(1);
  });
});

// --- The per-request read ---------------------------------------------------

describe("statusForSessionEmail", () => {
  it("answers unknown for an address nobody signs in with", async () => {
    const { usecase } = harness();
    const state = await usecase.statusForSessionEmail({
      tenantId: TEST_TENANT,
      sessionEmail: "stranger@mysp.vn",
    });
    expect(state.status).toBe("unknown");
  });

  it("answers unknown (never throws) for a malformed address", async () => {
    const { usecase } = harness();
    await expect(
      usecase.statusForSessionEmail({ tenantId: TEST_TENANT, sessionEmail: "  " }),
    ).resolves.toEqual({ status: "unknown", role: null, displayName: null });
  });

  it("finds a synthetic Facebook address case-insensitively", async () => {
    const { usecase } = harness([accessRow({ status: "approved", role: "editor" })]);
    const state = await usecase.statusForSessionEmail({
      tenantId: TEST_TENANT,
      sessionEmail: "FB-992710700450296@Facebook.Local",
    });
    expect(state).toEqual({
      status: "approved",
      role: "editor",
      displayName: "Nguyen Van A",
    });
  });

  it("reports a blocked identity as blocked, with no role", async () => {
    const { usecase } = harness([accessRow({ status: "blocked", role: "owner" })]);
    const state = await usecase.statusForSessionEmail({
      tenantId: TEST_TENANT,
      sessionEmail: "fb-992710700450296@facebook.local",
    });
    expect(state.status).toBe("blocked");
    expect(state.role).toBeNull();
  });

  it("does not leak an identity across tenants", async () => {
    const { usecase } = harness([
      accessRow({ tenantId: testTenantId("00000000-0000-0000-0000-0000000000ff"), status: "approved" }),
    ]);
    const state = await usecase.statusForSessionEmail({
      tenantId: TEST_TENANT,
      sessionEmail: "fb-992710700450296@facebook.local",
    });
    expect(state.status).toBe("unknown");
  });
});
