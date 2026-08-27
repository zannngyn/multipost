import { describe, expect, it, vi } from "vitest";

import { AppError } from "@/core/domain/errors";
import type { AccountRepo, MembershipWithTenant } from "@/core/ports/account-repo";
import type { LogBindings, Logger } from "@/core/ports/infra";
import type { CreateTenant, CreateTenantInput } from "@/core/usecases/create-tenant";

import {
  accountRecord,
  makeFakeAccountRepo,
  membershipRow,
  TENANT_X,
  TENANT_Y,
} from "./__fixtures__/account-repo";
import { DEFAULT_TENANT_NAME, makeEnsureDefaultTenant } from "./ensure-default-tenant";

/**
 * E10 — the organisation is provisioned lazily, on first entry. The whole
 * point of this file is the second visit: it must NOT mint a second company,
 * and neither must a second browser tab racing the first one.
 */

interface LogEntry {
  readonly level: "debug" | "info" | "warn" | "error";
  readonly message: string;
  readonly fields: Record<string, unknown>;
}

function recordingLogger(entries: LogEntry[], bound: Record<string, unknown> = {}): Logger {
  const write =
    (level: LogEntry["level"]) =>
    (message: string, fields: Record<string, unknown> = {}) => {
      entries.push({ level, message, fields: { ...bound, ...fields } });
    };
  return {
    child: (bindings: LogBindings) => recordingLogger(entries, { ...bound, ...bindings }),
    debug: write("debug"),
    info: write("info"),
    warn: write("warn"),
    error: write("error"),
  };
}

const INPUT = { accountId: "acc-1", sessionEmail: "founder@x.vn", displayName: "Chị Founder" };

function harness(options: {
  memberships?: MembershipWithTenant[];
  createTenant?: CreateTenant;
} = {}) {
  const accounts: AccountRepo = makeFakeAccountRepo([
    accountRecord({
      accountId: INPUT.accountId,
      sessionEmail: INPUT.sessionEmail,
      memberships: options.memberships ?? [],
    }),
  ]);
  const calls: CreateTenantInput[] = [];
  const createTenant: CreateTenant = vi.fn(async (input: CreateTenantInput) => {
    calls.push(input);
    return {
      tenant: {
        id: TENANT_Y,
        name: input.name,
        slug: "cong-ty-cua-toi",
        plan: "standard",
        role: "owner" as const,
      },
      activeTenantId: TENANT_Y,
    };
  });
  const entries: LogEntry[] = [];
  const usecase = makeEnsureDefaultTenant({
    accounts,
    createTenant: options.createTenant ?? createTenant,
    logger: recordingLogger(entries),
  });
  return { usecase, accounts, calls, entries };
}

// --- Edge cases first ---------------------------------------------------------

describe("ensureDefaultTenant — refusals", () => {
  it("401s without an account behind the session, before touching createTenant", async () => {
    const { usecase, calls } = harness();
    await expect(usecase({ ...INPUT, accountId: "  " })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    expect(calls).toHaveLength(0);
  });

  it("401s without a session e-mail — the account row needs one", async () => {
    const { usecase, calls } = harness();
    await expect(usecase({ ...INPUT, sessionEmail: "" })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    expect(calls).toHaveLength(0);
  });
});

// --- The invariant this file exists for --------------------------------------

describe("ensureDefaultTenant — never a second organisation", () => {
  it("returns the existing company and does NOT call createTenant", async () => {
    const { usecase, calls } = harness({ memberships: [membershipRow({ tenantId: TENANT_X })] });

    const result = await usecase(INPUT);

    expect(result).toEqual({ tenantId: TENANT_X, wasCreated: false });
    expect(calls).toHaveLength(0);
  });

  it("prefers an ACTIVE company when the account also belongs to a suspended one", async () => {
    const { usecase, calls } = harness({
      memberships: [
        membershipRow({ tenantId: TENANT_X, tenantStatus: "suspended" }),
        membershipRow({ tenantId: TENANT_Y, tenantStatus: "active" }),
      ],
    });

    const result = await usecase(INPUT);

    expect(result).toEqual({ tenantId: TENANT_Y, wasCreated: false });
    expect(calls).toHaveLength(0);
  });

  it("does not mint a fresh company for an account whose only company is suspended", async () => {
    // Otherwise a suspension would be one page-load away from being undone.
    const { usecase, calls, entries } = harness({
      memberships: [membershipRow({ tenantId: TENANT_X, tenantStatus: "suspended" })],
    });

    const result = await usecase(INPUT);

    expect(result).toEqual({ tenantId: TENANT_X, wasCreated: false });
    expect(calls).toHaveLength(0);
    expect(entries.some((entry) => entry.level === "warn")).toBe(true);
  });
});

// --- Concurrency: two tabs, one company --------------------------------------

describe("ensureDefaultTenant — two tabs at once", () => {
  it("adopts the company the racing request created instead of failing", async () => {
    // The repo transaction is what serialises the two creates; the loser comes
    // back with a typed refusal and finds the winner's membership on re-read.
    const accounts = makeFakeAccountRepo([
      accountRecord({
        accountId: INPUT.accountId,
        sessionEmail: INPUT.sessionEmail,
        memberships: [],
      }),
    ]);
    const record = accounts.records.get(INPUT.sessionEmail)!;
    const createTenant: CreateTenant = vi.fn(async () => {
      // The winning request commits while this one is inside the repo.
      record.memberships.push(membershipRow({ tenantId: TENANT_X, role: "owner" }));
      throw new AppError("TENANT_LIMIT_REACHED", { context: { limit: "per_hour" } });
    });
    const entries: LogEntry[] = [];
    const usecase = makeEnsureDefaultTenant({
      accounts,
      createTenant,
      logger: recordingLogger(entries),
    });

    const result = await usecase(INPUT);

    expect(result).toEqual({ tenantId: TENANT_X, wasCreated: false });
    expect(createTenant).toHaveBeenCalledTimes(1);
  });
});

// --- Abuse limits are NOT swallowed ------------------------------------------

describe("ensureDefaultTenant — abuse limits", () => {
  it("rethrows TENANT_LIMIT_REACHED untouched when no company appeared", async () => {
    const createTenant: CreateTenant = vi.fn(async () => {
      throw new AppError("TENANT_LIMIT_REACHED", { context: { limit: "total" } });
    });
    const { usecase, entries } = harness({ createTenant });

    await expect(usecase(INPUT)).rejects.toMatchObject({
      code: "TENANT_LIMIT_REACHED",
      context: { limit: "total" },
    });

    const logged = entries.find((entry) => entry.level === "error");
    expect(logged?.fields).toMatchObject({
      account_id: INPUT.accountId,
      error_code: "TENANT_LIMIT_REACHED",
    });
  });

  it("rethrows a non-AppError failure as-is", async () => {
    const boom = new Error("connection reset");
    const createTenant: CreateTenant = vi.fn(async () => {
      throw boom;
    });
    const { usecase } = harness({ createTenant });

    await expect(usecase(INPUT)).rejects.toBe(boom);
  });
});

// --- Happy path ---------------------------------------------------------------

describe("ensureDefaultTenant — first entry", () => {
  it("creates the default company and reports it as created", async () => {
    const { usecase, calls } = harness();

    const result = await usecase(INPUT);

    expect(result).toEqual({ tenantId: TENANT_Y, wasCreated: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      accountId: INPUT.accountId,
      sessionEmail: INPUT.sessionEmail,
      displayName: INPUT.displayName,
      name: DEFAULT_TENANT_NAME,
    });
  });

  it("names it 'Công ty của tôi' — never the person's name or e-mail", async () => {
    // `displayName` may be null and /api/me carries no e-mail, so anything
    // stitched together from them reads as a bug on screen.
    const { usecase, calls } = harness();

    await usecase({ ...INPUT, displayName: "Nguyễn Thế Vân" });

    expect(calls[0].name).toBe("Công ty của tôi");
    expect(calls[0].name).not.toContain("Nguyễn");
    expect(calls[0].name).not.toContain("@");
  });

  it("lets createTenant derive the slug — no slug is chosen here", async () => {
    // A slug WE choose collides hard (SLUG_TAKEN); a derived one retries with a
    // random suffix inside createTenant.
    const { usecase, calls } = harness();

    await usecase({ ...INPUT, displayName: null });

    expect(calls[0].slug ?? null).toBeNull();
    expect(calls[0].displayName ?? null).toBeNull();
  });
});
