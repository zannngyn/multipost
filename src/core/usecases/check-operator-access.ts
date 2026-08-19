import { toOperatorIdentity, type RawOperatorIdentity } from "@/core/domain/access-request";
import { AppError } from "@/core/domain/errors";
import { isTenantId } from "@/core/domain/tenant";
import type { AccessRequestRepo } from "@/core/ports/access-request-repo";
import type { Clock, Logger } from "@/core/ports/infra";
import { normaliseEmail, type AccessStatus, type OperatorRole } from "@/shared/operator-access";

/**
 * E1.4 — the two questions the auth layer asks the registry:
 *   1. sign-in: "is this identity allowed in?" (and file it if it is new);
 *   2. every request afterwards: "is the identity in this session STILL allowed?"
 *
 * Question 2 is the whole point of the feature. The session is a stateless JWT
 * (see app/_auth/auth.config.ts), so a decision taken at sign-in stays true for
 * the life of the token: without a per-request status read, "Chặn" would only
 * take effect when the blocked operator's cookie expires — a button that lies.
 */

/** `unknown` = no registry row at all, which is NOT the same as pending. */
export type AccessVerdict = AccessStatus | "unknown";

export interface OperatorAccessState {
  readonly status: AccessVerdict;
  /** Only ever set for `approved`; drives the admin gate on the review screen. */
  readonly role: OperatorRole | null;
  readonly displayName: string | null;
}

const UNKNOWN: OperatorAccessState = { status: "unknown", role: null, displayName: null };

export interface RegisterAccessRequestInput extends RawOperatorIdentity {
  readonly tenantId: string;
}

export interface SessionAccessInput {
  readonly tenantId: string;
  readonly sessionEmail: string;
}

export interface CheckOperatorAccessDeps {
  requests: AccessRequestRepo;
  clock: Clock;
  logger: Logger;
}

export interface CheckOperatorAccess {
  /**
   * Sign-in path. An unknown identity is RECORDED as pending and reported as
   * such, so the operator gets "đang chờ duyệt" and the admin gets a row to act
   * on — instead of the old flow, where the admin had to dig the app-scoped id
   * out of a log line after a failed sign-in.
   */
  registerAndCheck(input: RegisterAccessRequestInput): Promise<OperatorAccessState>;
  /** Session path. Never throws for a malformed address — it answers `unknown`. */
  statusForSessionEmail(input: SessionAccessInput): Promise<OperatorAccessState>;
}

export function makeCheckOperatorAccess(deps: CheckOperatorAccessDeps): CheckOperatorAccess {
  return {
    async registerAndCheck(input) {
      // --- Edge cases first ---------------------------------------------------
      const tenantId = requireTenant(input?.tenantId, "registerAndCheck");
      // Throws INVALID_INPUT for a provider payload we cannot file (no id, no
      // usable address). The caller turns that into a refused sign-in.
      const identity = toOperatorIdentity(input);

      const log = deps.logger.child({
        tenant_id: tenantId,
        provider: identity.provider,
        session_email: identity.sessionEmail,
      });

      const existing = await deps.requests.findByProviderAccount(
        tenantId,
        identity.provider,
        identity.providerAccountId,
      );
      if (existing) {
        log.info("Sign-in by a known identity", {
          access_status: existing.status,
          access_request_id: existing.id,
        });
        return toState(existing.status, existing.role, existing.displayName);
      }

      const created = await deps.requests.createPending({
        tenantId,
        identity,
        requestedAt: deps.clock.now(),
      });
      // Loud on purpose: this line is what tells an operator watching the log
      // that somebody is waiting, without anyone having to read app-scoped ids.
      log.warn("New sign-in identity recorded and held for approval", {
        error_code: "UNAUTHORIZED",
        access_status: created.status,
        access_request_id: created.id,
        display_name: created.displayName,
        alert: "OPERATOR_ATTENTION",
      });
      return toState(created.status, created.role, created.displayName);
    },

    async statusForSessionEmail(input) {
      const tenantId = requireTenant(input?.tenantId, "statusForSessionEmail");

      /**
       * A malformed address is `unknown`, not an exception: this runs on EVERY
       * request, and the caller reads `unknown` as "no session". Failing closed
       * quietly beats a 500 on every page for a cookie we do not recognise.
       */
      const sessionEmail = normaliseSessionEmail(input?.sessionEmail);
      if (!sessionEmail) return UNKNOWN;

      const found = await deps.requests.findBySessionEmail(tenantId, sessionEmail);
      if (!found) return UNKNOWN;

      return toState(found.status, found.role, found.displayName);
    },
  };
}

/**
 * The synthetic Facebook address (`fb-<id>@facebook.local`) is a valid session
 * key but not a valid e-mail, so this accepts anything non-empty and lets the
 * lookup decide. Lower-cased because the column is written lower-cased.
 */
function normaliseSessionEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = normaliseEmail(value) ?? value.trim().toLowerCase();
  return email.length > 0 && email.length <= 320 ? email : null;
}

function toState(
  status: AccessStatus,
  role: OperatorRole | null,
  displayName: string | null,
): OperatorAccessState {
  // Belt and braces: a hand-edited row could carry a role while blocked, and a
  // blocked identity must never hand an admin capability to the session layer.
  return { status, role: status === "approved" ? role : null, displayName };
}

function requireTenant(value: unknown, operation: string): string {
  const tenantId = typeof value === "string" ? value.trim() : "";
  if (!isTenantId(tenantId)) {
    throw new AppError("INVALID_INPUT", {
      message: `${operation} requires a tenant id`,
      userMessage: "Thiếu mã đơn vị (tenant) hợp lệ.",
      context: { operation, tenant_id: tenantId || null, field: "tenantId" },
    });
  }
  return tenantId;
}
