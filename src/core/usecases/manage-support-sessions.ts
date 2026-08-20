import { AppError } from "@/core/domain/errors";
import type { TenantId } from "@/core/domain/tenant-context";
import type { Clock, Logger } from "@/core/ports/infra";
import type {
  LiveSupportSession,
  OpenedSupportSession,
  SupportSessionRepo,
} from "@/core/ports/support-session-repo";

/**
 * M3.3 — support mode (docs/09 §3.5, doc 10 §8.1). Thin on purpose: the
 * transactional rules (revoke-then-open, audits under the target tenant, the
 * fresh liveness read) live in the repo; this usecase owns the input contract.
 *
 * There is NO extend/renew method — deliberately absent, not forgotten: more
 * time inside a customer's tenant means a NEW session and a NEW
 * `platform.entered_tenant` line in their book.
 */

/** One hour — long enough to debug, short enough that presence cannot linger. */
export const SUPPORT_SESSION_TTL_MS = 60 * 60 * 1000;

const PURPOSE_MIN = 10;
const PURPOSE_MAX = 500;

export interface OpenSupportSessionInput {
  readonly tenantId: TenantId;
  readonly purpose: string;
  readonly accountId: string;
  readonly actorEmail: string | null;
}

export interface CloseSupportSessionInput {
  readonly sessionId: string | null;
  readonly accountId: string;
  readonly actorEmail: string | null;
}

export interface ManageSupportSessions {
  open(input: OpenSupportSessionInput): Promise<OpenedSupportSession>;
  /** Idempotent; `already` covers both a re-close and a missing cookie. */
  close(input: CloseSupportSessionInput): Promise<{ revoked: boolean; already: boolean }>;
  /** Fresh liveness read for /api/me and requireTenant. Never throws on shape. */
  peek(sessionId: string | null, accountId: string | null): Promise<LiveSupportSession | null>;
}

export interface ManageSupportSessionsDeps {
  sessions: SupportSessionRepo;
  clock: Clock;
  logger: Logger;
}

export function makeManageSupportSessions(deps: ManageSupportSessionsDeps): ManageSupportSessions {
  return {
    async open(input) {
      // --- Edge case first: the purpose IS the audit entry — it must say why -
      const purpose = typeof input?.purpose === "string" ? input.purpose.trim() : "";
      if (purpose.length < PURPOSE_MIN || purpose.length > PURPOSE_MAX) {
        throw new AppError("INVALID_INPUT", {
          message: `Support session purpose must be ${PURPOSE_MIN}-${PURPOSE_MAX} characters`,
          userMessage: "Phải ghi mục đích vào hỗ trợ (ít nhất 10 ký tự).",
          context: { tenant_id: input?.tenantId ?? null, field: "purpose" },
        });
      }

      return deps.sessions.open({
        accountId: input.accountId,
        tenantId: input.tenantId,
        purpose,
        expiresAt: new Date(deps.clock.nowMs() + SUPPORT_SESSION_TTL_MS),
        now: deps.clock.now(),
        actorEmail: input.actorEmail,
      });
    },

    async close(input) {
      // No cookie = nothing to close: the exit the caller wanted already holds.
      if (!input?.sessionId) return { revoked: false, already: true };

      const outcome = await deps.sessions.close({
        sessionId: input.sessionId,
        accountId: input.accountId,
        now: deps.clock.now(),
        actorEmail: input.actorEmail,
      });
      return { revoked: outcome === "closed", already: outcome !== "closed" };
    },

    async peek(sessionId, accountId) {
      if (!sessionId || !accountId) return null;
      return deps.sessions.findLive(sessionId, accountId, deps.clock.now());
    },
  };
}
