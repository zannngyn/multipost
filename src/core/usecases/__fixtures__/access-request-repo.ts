import type { AccessRequest } from "@/core/domain/access-request";
import type {
  AccessRequestRepo,
  CreatePendingAccessRequestInput,
  DecideAccessRequestRecord,
} from "@/core/ports/access-request-repo";
import type { LogBindings, LogContext, Logger } from "@/core/ports/infra";
import type { AccessStatus, OperatorProvider } from "@/shared/operator-access";
import { testTenantId } from "@/core/domain/tenant-context.testing";

/**
 * In-memory `access_request` store for usecase tests. It mirrors the two
 * guarantees the real repo makes: the identity key is (provider, account id),
 * and `createPending` is idempotent.
 */

export const TEST_TENANT = testTenantId("00000000-0000-0000-0000-000000000001");

export function silentLogger(): Logger {
  const logger: Logger = {
    child: (_bindings: LogBindings) => logger,
    debug: (_message: string, _context?: LogContext) => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
  return logger;
}

export interface FakeAccessRepo extends AccessRequestRepo {
  rows(): AccessRequest[];
  seed(row: AccessRequest): void;
}

export function makeFakeAccessRepo(seed: AccessRequest[] = []): FakeAccessRepo {
  const store = new Map<string, AccessRequest>(seed.map((row) => [row.id, row]));
  let nextId = seed.length + 1;

  const identityKey = (provider: OperatorProvider, accountId: string) => `${provider}:${accountId}`;

  return {
    rows: () => [...store.values()],
    seed: (row) => {
      store.set(row.id, row);
    },

    async findByProviderAccount(tenantId, provider, providerAccountId) {
      const key = identityKey(provider, providerAccountId);
      return (
        [...store.values()].find(
          (row) =>
            row.tenantId === tenantId && identityKey(row.provider, row.providerAccountId) === key,
        ) ?? null
      );
    },

    async findBySessionEmail(tenantId, sessionEmail) {
      const email = sessionEmail.trim().toLowerCase();
      return (
        [...store.values()].find(
          (row) => row.tenantId === tenantId && row.sessionEmail.toLowerCase() === email,
        ) ?? null
      );
    },

    async createPending(input: CreatePendingAccessRequestInput) {
      const { identity } = input;
      const existing = await this.findByProviderAccount(
        input.tenantId,
        identity.provider,
        identity.providerAccountId,
      );
      if (existing) return existing;

      const row: AccessRequest = {
        id: `req-${nextId++}`,
        tenantId: input.tenantId,
        provider: identity.provider,
        providerAccountId: identity.providerAccountId,
        sessionEmail: identity.sessionEmail,
        email: identity.email,
        displayName: identity.displayName,
        status: "pending",
        role: null,
        requestedAt: input.requestedAt,
        decidedAt: null,
        decidedByEmail: null,
      };
      store.set(row.id, row);
      return row;
    },

    async list(tenantId, status: AccessStatus | "all") {
      return [...store.values()]
        .filter((row) => row.tenantId === tenantId && (status === "all" || row.status === status))
        .sort((left, right) => right.requestedAt.getTime() - left.requestedAt.getTime());
    },

    async decide(input: DecideAccessRequestRecord) {
      const current = store.get(input.id);
      if (!current || current.tenantId !== input.tenantId) return null;

      const next: AccessRequest = {
        ...current,
        status: input.status,
        role: input.status === "approved" ? input.role : null,
        decidedAt: input.decidedAt,
        decidedByEmail: input.decidedByEmail,
      };
      store.set(next.id, next);
      return next;
    },
  };
}

export function accessRow(overrides: Partial<AccessRequest> = {}): AccessRequest {
  return {
    id: "req-seed",
    tenantId: TEST_TENANT,
    provider: "facebook",
    providerAccountId: "992710700450296",
    sessionEmail: "fb-992710700450296@facebook.local",
    email: null,
    displayName: "Nguyen Van A",
    status: "pending",
    role: null,
    requestedAt: new Date("2026-08-19T03:00:00.000Z"),
    decidedAt: null,
    decidedByEmail: null,
    ...overrides,
  };
}
