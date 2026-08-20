import { AppError } from "@/core/domain/errors";
import type { Clock, Logger } from "@/core/ports/infra";
import type {
  CheckOperatorAccess,
  OperatorAccessState,
  RegisterAccessRequestInput,
} from "@/core/usecases/check-operator-access";
import { unbrandTenantId, type TenantId } from "@/core/domain/tenant-context";

/**
 * Per-request access check, with a short cache in front of it (E1.4).
 *
 * WHY A CACHE: `getOperatorSession` runs on EVERY page render and every API
 * route that reads the operator. Without this, blocking-that-actually-works
 * would cost one round trip to Postgres per request.
 *
 * WHY IT IS SHORT: the cache is what delays a block taking effect. Sixty
 * seconds is the same bound `AUTH_CACHE_TTL_MS` (adapters/google) settled on
 * for the same reason — long enough to erase the per-request query, short
 * enough that "Chặn" is felt within a minute even if an invalidation is missed
 * (another process, a rebuilt module instance). A decision taken in THIS
 * process clears it immediately, so the normal case is instant.
 */

export const ACCESS_CACHE_TTL_MS = 60_000;

/** Denies without naming a row: the safe reading when we cannot ask the DB. */
const DENIED: OperatorAccessState = { status: "unknown", role: null, displayName: null };

interface CacheEntry {
  readonly state: OperatorAccessState;
  /** Epoch ms after which the status is read from the database again. */
  readonly expiresAt: number;
}

export interface OperatorAccessGate {
  /**
   * Never throws. A database failure answers `unknown`, i.e. NO SESSION:
   * failing open here would mean "the DB is down, so everyone is allowed", and
   * the env bootstrap admins (checked before this gate) still get in to fix it.
   */
  readState(tenantId: TenantId, sessionEmail: string): Promise<OperatorAccessState>;
  /**
   * Sign-in path: file an unknown identity as `pending` and report its status.
   * Throws (unlike `readState`) — a sign-in that cannot reach the registry must
   * be refused loudly, not silently treated as "no session".
   */
  register(input: RegisterAccessRequestInput): Promise<OperatorAccessState>;
  /** Drops every cached status. Called the moment a decision is written. */
  invalidateAll(): void;
}

export interface OperatorAccessGateDeps {
  access: CheckOperatorAccess;
  clock: Clock;
  logger: Logger;
  /** Injection seam for tests. Defaults to ACCESS_CACHE_TTL_MS. */
  ttlMs?: number;
}

export function makeOperatorAccessGate(deps: OperatorAccessGateDeps): OperatorAccessGate {
  const ttlMs = typeof deps.ttlMs === "number" && deps.ttlMs > 0 ? deps.ttlMs : ACCESS_CACHE_TTL_MS;
  const cache = new Map<string, CacheEntry>();

  return {
    async readState(tenantId, sessionEmail) {
      // --- Edge cases first ---------------------------------------------------
      const email = typeof sessionEmail === "string" ? sessionEmail.trim().toLowerCase() : "";
      if (email.length === 0) return DENIED;

      const key = `${unbrandTenantId(tenantId)}:${email}`;
      const now = deps.clock.nowMs();
      const cached = cache.get(key);
      if (cached && cached.expiresAt > now) return cached.state;

      try {
        const state = await deps.access.statusForSessionEmail({ tenantId, sessionEmail: email });
        cache.set(key, { state, expiresAt: now + ttlMs });
        return state;
      } catch (error) {
        /**
         * Logged with context and turned into a denial — never cached: caching
         * a failure would keep everyone out for a minute after a one-off blip.
         */
        deps.logger.error("Could not read the operator access status — denying this request", {
          err: AppError.from(error, "DB_ERROR", { tenant_id: tenantId }),
          error_code: "UNAUTHORIZED",
          tenant_id: tenantId,
          session_email: email,
        });
        return DENIED;
      }
    },

    async register(input) {
      const state = await deps.access.registerAndCheck(input);
      // A sign-in is a fact about this identity that the cache may contradict
      // (an `unknown` read a moment earlier). Cheap to drop: sign-ins are rare.
      cache.clear();
      return state;
    },

    invalidateAll() {
      cache.clear();
    },
  };
}
