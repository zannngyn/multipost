import { describe, expect, it, vi } from "vitest";

import { AppError } from "@/core/domain/errors";
import { testTenantId } from "@/core/domain/tenant-context.testing";
import type { InviteRepo } from "@/core/ports/invite-repo";
import type { PlatformTenantRepo } from "@/core/ports/platform-tenant-repo";
import type { Clock, LogBindings, Logger } from "@/core/ports/infra";

import { makePlatformTenants } from "./platform-tenants";

/**
 * M3.2 — the provisioning flow: tenant WITHOUT a creator membership + one
 * single-use OWNER invite, and the mandatory reason on the status switch.
 */

const TENANT = testTenantId("00000000-0000-0000-0000-00000000d00d");

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

const clock: Clock = {
  now: () => new Date("2026-08-21T05:00:00Z"),
  nowMs: () => new Date("2026-08-21T05:00:00Z").getTime(),
};

function harness(options: { takenSlugs?: string[] } = {}) {
  const taken = new Set(options.takenSlugs ?? []);
  const createdSlugs: string[] = [];
  const platformTenants: PlatformTenantRepo = {
    listTenants: vi.fn(async () => []),
    createTenant: vi.fn(async (input) => {
      createdSlugs.push(input.slug);
      if (taken.has(input.slug)) throw new AppError("SLUG_TAKEN");
      return { id: TENANT, name: input.name, slug: input.slug, plan: input.plan, status: "active" as const };
    }),
    setStatus: vi.fn(async (input) => ({
      tenantId: input.tenantId,
      status: input.status,
      already: false,
    })),
  };
  const invites: InviteRepo = {
    listInvites: vi.fn(),
    createInvite: vi.fn(async () => ({ id: "inv-1" })),
    revokeInvite: vi.fn(),
    claimInvite: vi.fn(),
  };
  const usecase = makePlatformTenants({
    platformTenants,
    invites,
    clock,
    logger: silentLogger(),
    newToken: () => "p".repeat(64),
    hashToken: (token) => `hash:${token}`,
    randomSuffix: () => "ff00",
  });
  return { usecase, platformTenants, invites, createdSlugs };
}

const ACTOR = { actorAccountId: "acc-root", actorEmail: "root@mysp.vn" };

// --- Edge cases first ---------------------------------------------------------

describe("platform createTenant — refusals", () => {
  it("refuses a too-short name before the repo", async () => {
    const { usecase, platformTenants } = harness();
    await expect(usecase.createTenant({ name: "A", ...ACTOR })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    expect(platformTenants.createTenant).not.toHaveBeenCalled();
  });

  it("surfaces SLUG_TAKEN for a CHOSEN slug without retrying", async () => {
    const { usecase, createdSlugs } = harness({ takenSlugs: ["khach-a"] });
    await expect(
      usecase.createTenant({ name: "Khách A", slug: "khach-a", ...ACTOR }),
    ).rejects.toMatchObject({ code: "SLUG_TAKEN" });
    expect(createdSlugs).toEqual(["khach-a"]);
  });
});

describe("platform createTenant — the handover flow", () => {
  it("creates the tenant and mints ONE single-use owner invite, hash-only to the port", async () => {
    const { usecase, invites } = harness();

    const result = await usecase.createTenant({ name: "Khách A", ...ACTOR });

    expect(result.tenant).toMatchObject({ id: TENANT, slug: "khach-a", plan: "standard" });
    expect(result.ownerInviteToken).toBe("p".repeat(64));
    expect(result.inviteExpiresAt).toEqual(new Date("2026-08-28T05:00:00Z")); // 7 days
    expect(invites.createInvite).toHaveBeenCalledWith({
      tenantId: TENANT,
      role: "owner",
      tokenHash: `hash:${"p".repeat(64)}`,
      expiresAt: new Date("2026-08-28T05:00:00Z"),
      maxUses: 1,
      createdByAccountId: "acc-root",
      actorEmail: "root@mysp.vn",
    });
  });

  it("retries a DERIVED slug once on collision", async () => {
    const { usecase, createdSlugs } = harness({ takenSlugs: ["khach-a"] });
    const result = await usecase.createTenant({ name: "Khách A", ...ACTOR });
    expect(createdSlugs).toEqual(["khach-a", "khach-a-ff00"]);
    expect(result.tenant.slug).toBe("khach-a-ff00");
  });

  it("passes the plan through (internal allowed for MYSP's own)", async () => {
    const { usecase, platformTenants } = harness();
    await usecase.createTenant({ name: "MYSP Nội bộ", plan: "internal", ...ACTOR });
    expect(platformTenants.createTenant).toHaveBeenCalledWith(
      expect.objectContaining({ plan: "internal" }),
    );
  });
});

describe("platform setTenantStatus", () => {
  it("refuses a reason under 10 characters — heavy switches carry their why", async () => {
    const { usecase, platformTenants } = harness();
    await expect(
      usecase.setTenantStatus({ tenantId: TENANT, status: "suspended", reason: "spam", ...ACTOR }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(platformTenants.setStatus).not.toHaveBeenCalled();
  });

  it("passes a real reason through to the audited repo call", async () => {
    const { usecase, platformTenants } = harness();
    await usecase.setTenantStatus({
      tenantId: TENANT,
      status: "suspended",
      reason: "Khách nợ phí 3 tháng liên tiếp",
      ...ACTOR,
    });
    expect(platformTenants.setStatus).toHaveBeenCalledWith(
      expect.objectContaining({ status: "suspended", reason: "Khách nợ phí 3 tháng liên tiếp" }),
    );
  });
});
