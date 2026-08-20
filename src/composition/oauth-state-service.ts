import { createHash } from "node:crypto";

import { AppError } from "@/core/domain/errors";
import type { TenantId } from "@/core/domain/tenant-context";
import type { Clock } from "@/core/ports/infra";
import type {
  ClaimedOAuthState,
  OAuthPurpose,
  OAuthStateStore,
} from "@/core/ports/oauth-state-store";

/**
 * The nonce half of the server-side OAuth state (M1.3b, doc 10 §6). Hashing
 * lives HERE, in composition, because core owns no crypto (docs/07 §2) and the
 * adapter must never see a raw nonce.
 *
 * The nonce is not generated here: it IS the OAuth `state` the connect
 * usecases already mint through the container's `newState()` (32 random bytes,
 * hex — 256 bits, above the ≥128-bit floor of doc 10 §6). One value plays both
 * parts: the provider echoes it back as `state`, the cookie proves the
 * browser, and the hash stored here binds both to the (tenant, account)
 * frozen at flow start.
 */

/** 10 minutes — long enough for a login + consent, short enough not to linger. */
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

/** ≥128 bits: 32 hex chars. `newState()` provides 64; anything shorter is a bug. */
const MIN_NONCE_LENGTH = 32;

export interface RegisterOAuthNonceInput {
  readonly nonce: string;
  readonly tenantId: TenantId;
  readonly accountId: string;
  readonly purpose: OAuthPurpose;
}

export interface OAuthStateService {
  /** Stores the hash server-side; the raw nonce travels only cookie + URL. */
  issue(input: RegisterOAuthNonceInput): Promise<void>;
  /** Single-use. Null = unknown/used/expired/wrong purpose — one refusal. */
  claim(nonce: string, purpose: OAuthPurpose): Promise<ClaimedOAuthState | null>;
}

export function makeOAuthStateService(deps: {
  store: OAuthStateStore;
  clock: Clock;
}): OAuthStateService {
  const hash = (nonce: string): string => createHash("sha256").update(nonce).digest("hex");

  return {
    async issue(input) {
      // --- Edge case first: a weak nonce makes the whole binding theatre ----
      const nonce = typeof input?.nonce === "string" ? input.nonce.trim() : "";
      if (nonce.length < MIN_NONCE_LENGTH) {
        throw new AppError("INTERNAL", {
          message: "OAuth nonce is too short to bind a consent flow",
          context: { purpose: input?.purpose ?? null, nonce_length: nonce.length },
        });
      }

      await deps.store.issue({
        nonceHash: hash(nonce),
        tenantId: input.tenantId,
        accountId: input.accountId,
        purpose: input.purpose,
        expiresAt: new Date(deps.clock.nowMs() + OAUTH_STATE_TTL_MS),
      });
    },

    async claim(nonce, purpose) {
      // --- Edge case first: nothing to hash is nothing to claim -------------
      const trimmed = typeof nonce === "string" ? nonce.trim() : "";
      if (trimmed.length < MIN_NONCE_LENGTH) return null;

      return deps.store.claim({
        nonceHash: hash(trimmed),
        purpose,
        now: deps.clock.now(),
      });
    },
  };
}
