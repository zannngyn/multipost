import { AppError } from "@/core/domain/errors";
import type { Clock, Logger } from "@/core/ports/infra";
import type {
  OperatorAccountState,
  ResolveOperatorAccount,
  SignInAccountVerdict,
  SignInIdentityInput,
} from "@/core/usecases/resolve-operator-account";

/**
 * Per-request ACCOUNT check with a short cache in front (M1.2) — the successor
 * of `operator-access-gate` on the session path: `getOperatorSession` now asks
 * the account tables (identity → account → membership), not the registry.
 *
 * Same TTL discipline as the access gate and `AUTH_CACHE_TTL_MS`: 60s bounds
 * how long a suspension can lag behind ("phiên chết ≤60s"), a decision taken in
 * THIS process clears the cache immediately.
 */

export const ACCOUNT_CACHE_TTL_MS = 60_000;

interface CacheEntry {
  readonly state: OperatorAccountState | null;
  readonly expiresAt: number;
}

export interface OperatorAccountGate {
  /**
   * Never throws: a database failure answers null, i.e. NO SESSION. Failing
   * open would mean "the DB is down, so every cookie is valid".
   */
  resolve(sessionEmail: string): Promise<OperatorAccountState | null>;
  /** Sign-in path: fresh, throws on DB failure (the gate fails closed there). */
  signIn(input: SignInIdentityInput): Promise<SignInAccountVerdict>;
  /** Drops every cached account. Called the moment a decision is written. */
  invalidateAll(): void;
}

export interface OperatorAccountGateDeps {
  resolveAccount: ResolveOperatorAccount;
  clock: Clock;
  logger: Logger;
  /** Injection seam for tests. Defaults to ACCOUNT_CACHE_TTL_MS. */
  ttlMs?: number;
}

export function makeOperatorAccountGate(deps: OperatorAccountGateDeps): OperatorAccountGate {
  const ttlMs = typeof deps.ttlMs === "number" && deps.ttlMs > 0 ? deps.ttlMs : ACCOUNT_CACHE_TTL_MS;
  const cache = new Map<string, CacheEntry>();

  return {
    async resolve(sessionEmail) {
      // --- Edge cases first -------------------------------------------------
      const email = typeof sessionEmail === "string" ? sessionEmail.trim().toLowerCase() : "";
      if (email.length === 0) return null;

      const now = deps.clock.nowMs();
      const cached = cache.get(email);
      if (cached && cached.expiresAt > now) return cached.state;

      try {
        const state = await deps.resolveAccount.forSession(email);
        // "No account" is cached too: an unknown cookie hitting every request
        // must not turn into a per-request query.
        cache.set(email, { state, expiresAt: now + ttlMs });
        return state;
      } catch (error) {
        // Denied, logged, NEVER cached: caching a blip would lock everyone out
        // for a minute after it passes.
        deps.logger.error("Could not resolve the operator account — denying this request", {
          err: AppError.from(error, "DB_ERROR"),
          error_code: "UNAUTHORIZED",
          session_email: email,
        });
        return null;
      }
    },

    async signIn(input) {
      const verdict = await deps.resolveAccount.forSignIn(input);
      // A sign-in may have PATCHED the identity — anything cached about this
      // address predates that fact. Sign-ins are rare; dropping all is fine.
      cache.clear();
      return verdict;
    },

    invalidateAll() {
      cache.clear();
    },
  };
}
