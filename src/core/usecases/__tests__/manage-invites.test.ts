import { describe, expect, it, vi } from "vitest";

import { testTenantId } from "@/core/domain/tenant-context.testing";
import type { InviteRepo } from "@/core/ports/invite-repo";
import type { Clock, LogBindings, Logger } from "@/core/ports/infra";

import { makeManageInvites } from "../manage-invites";

/**
 * M2.2, the admin half. The test that matters most: the anti-escalation
 * ladder — an ADMIN minting an admin/owner invite is exactly how a tenant gets
 * quietly taken over, so it must die server-side regardless of the body.
 */

const TENANT = testTenantId("00000000-0000-0000-0000-00000000abba");

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
  now: () => new Date("2026-08-20T05:00:00Z"),
  nowMs: () => new Date("2026-08-20T05:00:00Z").getTime(),
};

function harness(overrides: Partial<InviteRepo> = {}) {
  const invites: InviteRepo = {
    listInvites: vi.fn(async () => []),
    createInvite: vi.fn(async () => ({ id: "inv-1" })),
    revokeInvite: vi.fn(async () => "revoked" as const),
    claimInvite: vi.fn(),
    ...overrides,
  };
  const usecase = makeManageInvites({
    invites,
    clock,
    logger: silentLogger(),
    newToken: () => "t".repeat(64),
    hashToken: (token) => `hash:${token}`,
  });
  return { usecase, invites };
}

const CREATE_BASE = {
  tenantId: TENANT,
  inviterAccountId: "acc-admin",
  inviterEmail: "admin@x.vn",
};

// --- The ladder (edge cases first) --------------------------------------------

describe("createInvite — anti-escalation ladder", () => {
  it("REFUSES an admin minting an admin invite — takeover shape", async () => {
    const { usecase, invites } = harness();
    await expect(
      usecase.createInvite({ ...CREATE_BASE, inviterRole: "admin", role: "admin" }),
    ).rejects.toMatchObject({ code: "INVITE_ROLE_FORBIDDEN" });
    expect(invites.createInvite).not.toHaveBeenCalled();
  });

  it("refuses an admin minting an OWNER invite", async () => {
    const { usecase } = harness();
    await expect(
      usecase.createInvite({ ...CREATE_BASE, inviterRole: "admin", role: "owner" }),
    ).rejects.toMatchObject({ code: "INVITE_ROLE_FORBIDDEN" });
  });

  it("refuses an unknown role outright", async () => {
    const { usecase } = harness();
    await expect(
      usecase.createInvite({ ...CREATE_BASE, inviterRole: "owner", role: "superuser" }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("lets an admin grant editor and viewer", async () => {
    const { usecase } = harness();
    await expect(
      usecase.createInvite({ ...CREATE_BASE, inviterRole: "admin", role: "editor" }),
    ).resolves.toMatchObject({ role: "editor" });
    await expect(
      usecase.createInvite({ ...CREATE_BASE, inviterRole: "admin", role: "viewer" }),
    ).resolves.toMatchObject({ role: "viewer" });
  });

  it("lets an owner grant every role, owner included", async () => {
    const { usecase } = harness();
    await expect(
      usecase.createInvite({ ...CREATE_BASE, inviterRole: "owner", role: "owner" }),
    ).resolves.toMatchObject({ role: "owner" });
  });
});

describe("createInvite — the token", () => {
  it("returns the RAW token exactly once and hands the port only its hash", async () => {
    const { usecase, invites } = harness();
    const created = await usecase.createInvite({
      ...CREATE_BASE,
      inviterRole: "owner",
      role: "editor",
    });

    expect(created.token).toBe("t".repeat(64));
    expect(invites.createInvite).toHaveBeenCalledWith(
      expect.objectContaining({
        tokenHash: `hash:${"t".repeat(64)}`,
        maxUses: 1, // single-use by default (docs/09 §3.6)
        role: "editor",
      }),
    );
    // 7-day TTL from the clock.
    expect(created.expiresAt).toEqual(new Date("2026-08-27T05:00:00Z"));
  });
});

describe("revokeInvite", () => {
  it("answers success for a repeat revoke — idempotent", async () => {
    const { usecase } = harness({ revokeInvite: vi.fn(async () => "already_revoked" as const) });
    await expect(
      usecase.revokeInvite({ tenantId: TENANT, id: "inv-1", actorAccountId: "a", actorEmail: null }),
    ).resolves.toEqual({ id: "inv-1", revoked: true });
  });

  it("answers INVITE_INVALID for an id this tenant does not hold", async () => {
    const { usecase } = harness({ revokeInvite: vi.fn(async () => "not_found" as const) });
    await expect(
      usecase.revokeInvite({ tenantId: TENANT, id: "inv-9", actorAccountId: "a", actorEmail: null }),
    ).rejects.toMatchObject({ code: "INVITE_INVALID" });
  });
});
