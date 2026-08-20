import { describe, expect, it, vi } from "vitest";

import { testTenantId } from "@/core/domain/tenant-context.testing";
import type { ClaimInviteResult, InviteRepo } from "@/core/ports/invite-repo";
import type { Clock, LogBindings, Logger } from "@/core/ports/infra";

import { makeJoinWithInvite } from "./join-with-invite";

/** M2.2 — /join's brain: one refusal code outside, exact reasons in the log. */

const TENANT = testTenantId("00000000-0000-0000-0000-00000000face");
const TENANT_SUMMARY = { id: TENANT, name: "Công ty X", slug: "x", plan: "standard" as const };

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

const clock: Clock = { now: () => new Date("2026-08-20T05:00:00Z"), nowMs: () => 0 };

function harness(result: ClaimInviteResult) {
  const claimInvite = vi.fn(async () => result);
  const invites: InviteRepo = {
    listInvites: vi.fn(),
    createInvite: vi.fn(),
    revokeInvite: vi.fn(),
    claimInvite,
  };
  const usecase = makeJoinWithInvite({
    invites,
    clock,
    logger: silentLogger(),
    hashToken: (token) => `hash:${token}`,
  });
  return { usecase, claimInvite };
}

const TOKEN = "k".repeat(64);
const INPUT = { accountId: "acc-1", sessionEmail: "new@x.vn", token: TOKEN };

// --- Edge cases first ---------------------------------------------------------

describe("joinWithInvite — refusals", () => {
  it("401s without an account behind the session", async () => {
    const { usecase } = harness({ kind: "invalid", reason: "x" });
    await expect(usecase({ ...INPUT, accountId: "" })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });

  it("refuses a garbage token BEFORE the lookup, with the same code as every refusal", async () => {
    const { usecase, claimInvite } = harness({ kind: "invalid", reason: "x" });
    await expect(usecase({ ...INPUT, token: "short" })).rejects.toMatchObject({
      code: "INVITE_INVALID",
    });
    expect(claimInvite).not.toHaveBeenCalled();
  });

  it("maps EVERY repo refusal to the one INVITE_INVALID", async () => {
    const { usecase } = harness({ kind: "invalid", reason: "REVOKED" });
    await expect(usecase(INPUT)).rejects.toMatchObject({ code: "INVITE_INVALID" });
  });

  it("hashes the token before it reaches the port", async () => {
    const { usecase, claimInvite } = harness({
      kind: "joined",
      tenant: TENANT_SUMMARY,
      role: "editor",
    });
    await usecase(INPUT);
    expect(claimInvite).toHaveBeenCalledWith(
      expect.objectContaining({ tokenHash: `hash:${TOKEN}` }),
    );
  });
});

describe("joinWithInvite — outcomes", () => {
  it("answers the joined tenant + role", async () => {
    const { usecase } = harness({ kind: "joined", tenant: TENANT_SUMMARY, role: "editor" });
    await expect(usecase(INPUT)).resolves.toEqual({
      tenant: TENANT_SUMMARY,
      role: "editor",
      alreadyMember: false,
    });
  });

  it("answers alreadyMember=true as a 200-shaped no-op, keeping the CURRENT role", async () => {
    const { usecase } = harness({ kind: "already_member", tenant: TENANT_SUMMARY, role: "owner" });
    await expect(usecase(INPUT)).resolves.toEqual({
      tenant: TENANT_SUMMARY,
      role: "owner",
      alreadyMember: true,
    });
  });
});
