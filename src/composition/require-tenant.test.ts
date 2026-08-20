import { describe, expect, it, vi } from "vitest";

import type { Clock, LogBindings, Logger } from "@/core/ports/infra";
import {
  accountRecord,
  makeFakeAccountRepo,
  membershipRow,
  TENANT_X,
  TENANT_Y,
} from "@/core/usecases/__fixtures__/account-repo";

import { makeRequireTenant } from "./require-tenant";

/**
 * `requireTenant` — the M1.3 authoriser, pinned down branch by branch before a
 * single route depends on it. Error semantics are the contract of doc 10 §3;
 * getting one of them wrong later would change 40 routes at once.
 */

function silentLogger(): Logger {
  const logger: Logger = {
    child: (_bindings: LogBindings) => logger,
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
  return logger;
}

function harness(records = [accountRecord()], ttlMs = 60_000) {
  let nowMs = 1_000;
  const clock: Clock = { now: () => new Date(nowMs), nowMs: () => nowMs };
  const accounts = makeFakeAccountRepo(records);
  const findMembership = vi.spyOn(accounts, "findMembership");
  const findMembershipVersion = vi.spyOn(accounts, "findMembershipVersion");
  const findSupportSession = vi.fn(
    async (): Promise<{ tenantId: never; expiresAt: Date } | null> => null,
  );
  const gate = makeRequireTenant({
    accounts,
    findSupportSession,
    clock,
    logger: silentLogger(),
    ttlMs,
  });
  return {
    gate,
    accounts,
    findMembership,
    findMembershipVersion,
    findSupportSession,
    advance: (ms: number) => (nowMs += ms),
  };
}

const SESSION = { accountId: "acc-1", email: "worker@gmail.com" };

// --- Refusals first (doc 10 §3) ----------------------------------------------

describe("requireTenant — refusals", () => {
  it("401s with no session at all", async () => {
    const { gate } = harness();
    await expect(gate.requireTenant(null, TENANT_X, { tier: "R" })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });

  it("401s a session with no account behind it (bootstrap without a row)", async () => {
    const { gate } = harness();
    await expect(
      gate.requireTenant({ accountId: null, email: "boss@mysp.vn" }, TENANT_X, { tier: "R" }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("refuses a caller that cannot name its tier", async () => {
    const { gate } = harness();
    await expect(
      gate.requireTenant(SESSION, TENANT_X, { tier: "fast" as never }),
    ).rejects.toMatchObject({ code: "INTERNAL" });
  });

  it("409s TENANT_NOT_SELECTED with no cookie and no membership anywhere", async () => {
    const { gate } = harness([accountRecord({ memberships: [] })]);
    await expect(gate.requireTenant(SESSION, null, { tier: "R" })).rejects.toMatchObject({
      code: "TENANT_NOT_SELECTED",
    });
  });

  it("409s with no cookie and TWO memberships — never guesses a company", async () => {
    const { gate } = harness([
      accountRecord({
        memberships: [membershipRow(), membershipRow({ tenantId: TENANT_Y, role: "viewer" })],
      }),
    ]);
    await expect(gate.requireTenant(SESSION, undefined, { tier: "R" })).rejects.toMatchObject({
      code: "TENANT_NOT_SELECTED",
    });
  });

  it("404s a cookie pointing at a tenant with no membership — indistinguishable from absent", async () => {
    const { gate } = harness();
    await expect(gate.requireTenant(SESSION, TENANT_Y, { tier: "S" })).rejects.toMatchObject({
      code: "TENANT_NOT_FOUND",
    });
  });

  it("404s a removed membership", async () => {
    const { gate } = harness([
      accountRecord({ memberships: [membershipRow({ status: "removed" })] }),
    ]);
    await expect(gate.requireTenant(SESSION, TENANT_X, { tier: "S" })).rejects.toMatchObject({
      code: "TENANT_NOT_FOUND",
    });
  });

  it("404s a suspended tenant — every member is out at once", async () => {
    const { gate } = harness([
      accountRecord({ memberships: [membershipRow({ tenantStatus: "suspended" })] }),
    ]);
    await expect(gate.requireTenant(SESSION, TENANT_X, { tier: "S" })).rejects.toMatchObject({
      code: "TENANT_NOT_FOUND",
    });
  });

  it("403s FORBIDDEN when the membership role is below minRole", async () => {
    const { gate } = harness([accountRecord({ memberships: [membershipRow({ role: "editor" })] })]);
    await expect(
      gate.requireTenant(SESSION, TENANT_X, { tier: "S", minRole: "admin" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("treats a garbage cookie as unselected, not as an error", async () => {
    const { gate } = harness([
      accountRecord({
        memberships: [membershipRow(), membershipRow({ tenantId: TENANT_Y })],
      }),
    ]);
    await expect(
      gate.requireTenant(SESSION, "<script>alert(1)</script>", { tier: "R" }),
    ).rejects.toMatchObject({ code: "TENANT_NOT_SELECTED" });
  });
});

// --- Happy paths --------------------------------------------------------------

describe("requireTenant — grants", () => {
  it("auto-selects the single company when there is no cookie", async () => {
    const { gate } = harness();
    const context = await gate.requireTenant(SESSION, null, { tier: "R" });
    expect(context).toEqual({ tenantId: TENANT_X, role: "editor", membershipVersion: 1 });
  });

  it("honours the cookie when the membership is real", async () => {
    const { gate } = harness([
      accountRecord({
        memberships: [membershipRow(), membershipRow({ tenantId: TENANT_Y, role: "owner" })],
      }),
    ]);
    const context = await gate.requireTenant(SESSION, TENANT_Y, { tier: "M" });
    expect(context.tenantId).toBe(TENANT_Y);
    expect(context.role).toBe("owner");
  });

  it("passes minRole when the ladder allows it (owner >= editor)", async () => {
    const { gate } = harness([accountRecord({ memberships: [membershipRow({ role: "owner" })] })]);
    await expect(
      gate.requireTenant(SESSION, TENANT_X, { tier: "S", minRole: "editor" }),
    ).resolves.toMatchObject({ role: "owner" });
  });
});

// --- The three tiers ----------------------------------------------------------

describe("requireTenant — cache tiers", () => {
  it("tier S reads the database fresh on EVERY call", async () => {
    const { gate, findMembership } = harness();
    await gate.requireTenant(SESSION, TENANT_X, { tier: "S" });
    await gate.requireTenant(SESSION, TENANT_X, { tier: "S" });
    expect(findMembership).toHaveBeenCalledTimes(2);
  });

  it("tier R serves the second call from cache", async () => {
    const { gate, findMembership } = harness();
    await gate.requireTenant(SESSION, TENANT_X, { tier: "R" });
    await gate.requireTenant(SESSION, TENANT_X, { tier: "R" });
    expect(findMembership).toHaveBeenCalledTimes(1);
  });

  it("tier R re-reads after the TTL", async () => {
    const { gate, findMembership, advance } = harness();
    await gate.requireTenant(SESSION, TENANT_X, { tier: "R" });
    advance(60_001);
    await gate.requireTenant(SESSION, TENANT_X, { tier: "R" });
    expect(findMembership).toHaveBeenCalledTimes(2);
  });

  it("tier M trusts the cache only while the fresh version matches", async () => {
    const { gate, accounts, findMembership, findMembershipVersion } = harness();
    await gate.requireTenant(SESSION, TENANT_X, { tier: "M" });

    // Same version: served from cache, one cheap version read.
    await gate.requireTenant(SESSION, TENANT_X, { tier: "M" });
    expect(findMembership).toHaveBeenCalledTimes(1);
    expect(findMembershipVersion).toHaveBeenCalledTimes(1);

    // Revoke in another process: version bumps, role drops — tier M must see it
    // mid-TTL.
    const record = [...accounts.records.values()][0];
    record.memberships[0] = membershipRow({ role: "viewer", version: 2 });
    record.summary = {
      ...record.summary,
      activeMemberships: [{ tenantId: TENANT_X, role: "viewer", version: 2 }],
    };

    const context = await gate.requireTenant(SESSION, TENANT_X, { tier: "M" });
    expect(context).toMatchObject({ role: "viewer", membershipVersion: 2 });
  });

  it("a denial is never cached — an approval in between is seen immediately", async () => {
    const { gate, accounts } = harness([accountRecord({ memberships: [] })]);
    await expect(gate.requireTenant(SESSION, TENANT_X, { tier: "R" })).rejects.toMatchObject({
      code: "TENANT_NOT_FOUND",
    });

    const record = [...accounts.records.values()][0];
    record.memberships.push(membershipRow());

    await expect(gate.requireTenant(SESSION, TENANT_X, { tier: "R" })).resolves.toMatchObject({
      tenantId: TENANT_X,
    });
  });

  it("invalidateAll drops the cache the moment a decision is written", async () => {
    const { gate, findMembership } = harness();
    await gate.requireTenant(SESSION, TENANT_X, { tier: "R" });
    gate.invalidateAll();
    await gate.requireTenant(SESSION, TENANT_X, { tier: "R" });
    expect(findMembership).toHaveBeenCalledTimes(2);
  });
});

// --- M3.3: the support-mode fallback ------------------------------------------

describe("requireTenant — support sessions (doc 10 §8.1: read-only)", () => {
  const SUPPORT_SESSION = "99999999-8888-7777-6666-555555555555";
  const liveVisit = { tenantId: TENANT_Y as never, expiresAt: new Date("2026-08-22T06:00:00Z") };

  it("grants a READ context for the visited tenant when every membership missed", async () => {
    const { gate, findSupportSession } = harness([accountRecord({ memberships: [] })]);
    findSupportSession.mockResolvedValue(liveVisit);

    const context = await gate.requireTenant(SESSION, null, {
      tier: "R",
      supportSessionId: SUPPORT_SESSION,
    });

    expect(context).toEqual({
      tenantId: TENANT_Y,
      role: "viewer",
      membershipVersion: 0,
      supportMode: true,
    });
    expect(findSupportSession).toHaveBeenCalledWith(SUPPORT_SESSION, "acc-1");
  });

  it.each(["M", "S"] as const)(
    "403s tier %s — support never writes a customer's data",
    async (tier) => {
      const { gate, findSupportSession } = harness([accountRecord({ memberships: [] })]);
      findSupportSession.mockResolvedValue(liveVisit);

      await expect(
        gate.requireTenant(SESSION, TENANT_Y, { tier, supportSessionId: SUPPORT_SESSION }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    },
  );

  it("an expired/revoked visit (fresh read answers null) falls back to the normal refusal", async () => {
    const { gate, findSupportSession } = harness([accountRecord({ memberships: [] })]);
    findSupportSession.mockResolvedValue(null);

    await expect(
      gate.requireTenant(SESSION, TENANT_Y, { tier: "R", supportSessionId: SUPPORT_SESSION }),
    ).rejects.toMatchObject({ code: "TENANT_NOT_FOUND" });
  });

  it("a REAL membership wins: the visit is never consulted on a membership hit", async () => {
    const { gate, findSupportSession } = harness(); // member of TENANT_X
    findSupportSession.mockResolvedValue(liveVisit);

    const context = await gate.requireTenant(SESSION, TENANT_X, {
      tier: "R",
      supportSessionId: SUPPORT_SESSION,
    });

    expect(context.supportMode).toBeUndefined();
    expect(context.role).toBe("editor");
    expect(findSupportSession).not.toHaveBeenCalled();
  });

  it("the visit is NOT a skeleton key: a selector for a THIRD tenant still 404s", async () => {
    const { gate, findSupportSession } = harness([accountRecord({ memberships: [] })]);
    findSupportSession.mockResolvedValue(liveVisit); // visit covers TENANT_Y

    await expect(
      gate.requireTenant(SESSION, TENANT_X, { tier: "R", supportSessionId: SUPPORT_SESSION }),
    ).rejects.toMatchObject({ code: "TENANT_NOT_FOUND" });
  });

  it("no support cookie → the fallback never queries", async () => {
    const { gate, findSupportSession } = harness([accountRecord({ memberships: [] })]);

    await expect(gate.requireTenant(SESSION, null, { tier: "R" })).rejects.toMatchObject({
      code: "TENANT_NOT_SELECTED",
    });
    expect(findSupportSession).not.toHaveBeenCalled();
  });
});

