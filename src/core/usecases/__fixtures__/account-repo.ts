import type {
  AccountRepo,
  AttachProviderAccountIdInput,
  MembershipWithTenant,
  OperatorAccountSummary,
} from "@/core/ports/account-repo";

/**
 * In-memory `account`/`identity`/`membership` store for usecase and gate tests.
 * Mirrors the real repo's contracts: session-e-mail lookup folds case, and
 * `attachProviderAccountId` PATCHES — it never grows the store.
 */

export const TENANT_X = "00000000-0000-0000-0000-00000000000a";
export const TENANT_Y = "00000000-0000-0000-0000-00000000000b";

export interface FakeAccountRecord {
  summary: OperatorAccountSummary;
  memberships: MembershipWithTenant[];
}

export interface FakeAccountRepo extends AccountRepo {
  records: Map<string, FakeAccountRecord>;
  patches: AttachProviderAccountIdInput[];
}

export function membershipRow(overrides: Partial<MembershipWithTenant> = {}): MembershipWithTenant {
  return {
    tenantId: TENANT_X,
    role: "editor",
    status: "active",
    version: 1,
    tenantStatus: "active",
    tenantName: "Công ty X",
    tenantSlug: "x",
    tenantPlan: "standard",
    ...overrides,
  };
}

export function accountRecord(overrides: {
  accountId?: string;
  status?: "active" | "suspended";
  sessionEmail?: string;
  providerAccountId?: string;
  memberships?: MembershipWithTenant[];
} = {}): FakeAccountRecord {
  const sessionEmail = overrides.sessionEmail ?? "worker@gmail.com";
  const membershipRows = overrides.memberships ?? [membershipRow()];
  return {
    summary: {
      accountId: overrides.accountId ?? "acc-1",
      status: overrides.status ?? "active",
      platformRole: null,
      displayName: "Worker",
      identity: {
        provider: "google",
        providerAccountId: overrides.providerAccountId ?? "legacy-app-user:worker@gmail.com",
        sessionEmail,
        email: sessionEmail,
      },
      activeMemberships: membershipRows
        .filter((m) => m.status === "active")
        .map((m) => ({ tenantId: m.tenantId, role: m.role, version: m.version })),
    },
    memberships: membershipRows,
  };
}

export function makeFakeAccountRepo(seed: FakeAccountRecord[] = []): FakeAccountRepo {
  const records = new Map<string, FakeAccountRecord>(
    seed.map((record) => [record.summary.identity.sessionEmail.toLowerCase(), record]),
  );
  const patches: AttachProviderAccountIdInput[] = [];

  return {
    records,
    patches,

    async findAccountBySessionEmail(sessionEmail) {
      return records.get(sessionEmail.trim().toLowerCase())?.summary ?? null;
    },

    async attachProviderAccountId(input) {
      patches.push(input);
      const record = records.get(input.sessionEmail.trim().toLowerCase());
      if (!record || record.summary.identity.provider !== input.provider) return false;
      record.summary = {
        ...record.summary,
        identity: { ...record.summary.identity, providerAccountId: input.providerAccountId },
      };
      return true;
    },

    async findMembership(accountId, tenantId) {
      for (const record of records.values()) {
        if (record.summary.accountId !== accountId) continue;
        return record.memberships.find((m) => m.tenantId === tenantId) ?? null;
      }
      return null;
    },

    // Independent of findMembership on purpose: tests spy on the two methods
    // separately to prove which read a cache tier actually performed.
    async findMembershipVersion(accountId, tenantId) {
      for (const record of records.values()) {
        if (record.summary.accountId !== accountId) continue;
        return record.memberships.find((m) => m.tenantId === tenantId)?.version ?? null;
      }
      return null;
    },

    async listMembershipsWithTenant(accountId) {
      for (const record of records.values()) {
        if (record.summary.accountId !== accountId) continue;
        return record.memberships.filter((m) => m.status === "active");
      }
      return [];
    },
  };
}
