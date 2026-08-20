import { describe, expect, it, vi } from "vitest";

import type { AccountRepo } from "@/core/ports/account-repo";
import type { LogBindings, Logger } from "@/core/ports/infra";
import { accountRecord, makeFakeAccountRepo } from "@/core/usecases/__fixtures__/account-repo";

import { makeRequirePlatformAdmin } from "./require-platform-admin";

/**
 * M3.1 — the platform authoriser, branch by branch. The one that closes N9:
 * a SUSPENDED account with a platform role is refused, on a FRESH read.
 */

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

function harness(
  standing: { status: "active" | "suspended"; platformRole: "support" | "super_admin" | null } | null,
) {
  const accounts = makeFakeAccountRepo([accountRecord()]);
  const findPlatformStanding = vi.fn(async () => standing);
  const patched: AccountRepo = { ...accounts, findPlatformStanding };
  return {
    requirePlatformAdmin: makeRequirePlatformAdmin({ accounts: patched, logger: silentLogger() }),
    findPlatformStanding,
  };
}

const SESSION = { accountId: "acc-1", email: "boss@mysp.vn" };

// --- Refusals first -----------------------------------------------------------

describe("requirePlatformAdmin — refusals", () => {
  it("401s with no session", async () => {
    const { requirePlatformAdmin } = harness(null);
    await expect(requirePlatformAdmin(null, { minRole: "support" })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });

  it("401s a session with no account (the rescue-door bootstrap) — platform never runs on env alone", async () => {
    const { requirePlatformAdmin } = harness(null);
    await expect(
      requirePlatformAdmin({ accountId: null, email: "boss@mysp.vn" }, { minRole: "support" }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("403s an account with NO platform role", async () => {
    const { requirePlatformAdmin } = harness({ status: "active", platformRole: null });
    await expect(requirePlatformAdmin(SESSION, { minRole: "support" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("403s a SUSPENDED super_admin — N9, judged on the fresh row", async () => {
    const { requirePlatformAdmin } = harness({ status: "suspended", platformRole: "super_admin" });
    await expect(requirePlatformAdmin(SESSION, { minRole: "support" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("403s support below the super_admin bar (mutations)", async () => {
    const { requirePlatformAdmin } = harness({ status: "active", platformRole: "support" });
    await expect(requirePlatformAdmin(SESSION, { minRole: "super_admin" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("refuses a caller that cannot name its minimum role", async () => {
    const { requirePlatformAdmin } = harness({ status: "active", platformRole: "super_admin" });
    await expect(
      requirePlatformAdmin(SESSION, { minRole: "root" as never }),
    ).rejects.toMatchObject({ code: "INTERNAL" });
  });
});

// --- Grants + freshness ---------------------------------------------------------

describe("requirePlatformAdmin — grants", () => {
  it("lets support read and super_admin do everything", async () => {
    const support = harness({ status: "active", platformRole: "support" });
    await expect(
      support.requirePlatformAdmin(SESSION, { minRole: "support" }),
    ).resolves.toEqual({ accountId: "acc-1", platformRole: "support" });

    const admin = harness({ status: "active", platformRole: "super_admin" });
    await expect(
      admin.requirePlatformAdmin(SESSION, { minRole: "super_admin" }),
    ).resolves.toMatchObject({ platformRole: "super_admin" });
  });

  it("reads the standing FRESH on every call — tier S, no cache", async () => {
    const { requirePlatformAdmin, findPlatformStanding } = harness({
      status: "active",
      platformRole: "super_admin",
    });
    await requirePlatformAdmin(SESSION, { minRole: "support" });
    await requirePlatformAdmin(SESSION, { minRole: "support" });
    expect(findPlatformStanding).toHaveBeenCalledTimes(2);
  });
});
