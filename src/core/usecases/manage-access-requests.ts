import type { AccessRequest } from "@/core/domain/access-request";
import { AppError } from "@/core/domain/errors";
import { isTenantId } from "@/core/domain/tenant";
import type { AccessRequestRepo } from "@/core/ports/access-request-repo";
import type { Clock, Logger } from "@/core/ports/infra";
import type { UserRepo } from "@/core/ports/user-repo";
import {
  isAccessStatus,
  isOperatorRole,
  normaliseEmail,
  OPERATOR_ROLES,
  type AccessStatus,
  type OperatorProvider,
  type OperatorRole,
} from "@/shared/operator-access";

import { resolveActorUserId } from "./resolve-actor";

/**
 * E1.4 — the admin half of the access registry: see who is waiting, approve
 * with a role, or block.
 *
 * A decision is not a preference, it is a security event: the repo writes the
 * registry row, the `app_user` row an approval implies, and the `audit_log`
 * entry in ONE transaction (see ports/access-request-repo). Nothing here
 * "remembers to" log — an approval that could not be recorded does not happen.
 */

/** Serialisable shape the API returns. Dates are ISO strings, never Date. */
export interface AccessRequestView {
  readonly id: string;
  readonly provider: OperatorProvider;
  readonly providerAccountId: string;
  readonly displayName: string | null;
  /** Null is normal: Facebook does not guarantee an address. */
  readonly email: string | null;
  readonly status: AccessStatus;
  readonly role: OperatorRole | null;
  readonly requestedAt: string;
  readonly decidedAt: string | null;
  readonly decidedByEmail: string | null;
}

/**
 * Allowlist on the way out. `sessionEmail` stays on the server on purpose: it
 * is the session key, and a screen that shows it invites someone to treat it as
 * a contact address.
 */
export function toAccessRequestView(request: AccessRequest): AccessRequestView {
  return {
    id: request.id,
    provider: request.provider,
    providerAccountId: request.providerAccountId,
    displayName: request.displayName,
    email: request.email,
    status: request.status,
    role: request.role,
    requestedAt: request.requestedAt.toISOString(),
    decidedAt: request.decidedAt ? request.decidedAt.toISOString() : null,
    decidedByEmail: request.decidedByEmail,
  };
}

export type AccessListFilter = AccessStatus | "all";

export interface ListAccessRequestsInput {
  readonly tenantId: string;
  /** Defaults to `pending` — the only list an admin normally needs to act on. */
  readonly status?: AccessListFilter;
}

export const ACCESS_DECISIONS = ["approve", "block"] as const;
export type AccessDecision = (typeof ACCESS_DECISIONS)[number];

export interface DecideAccessRequestInput {
  readonly tenantId: string;
  readonly id: string;
  readonly decision: AccessDecision;
  /** Required for `approve`, ignored for `block`. */
  readonly role?: unknown;
  readonly actorEmail?: string | null;
}

export interface AccessDecisionResult {
  readonly id: string;
  readonly status: AccessStatus;
  readonly role: OperatorRole | null;
}

export interface ManageAccessRequestsDeps {
  requests: AccessRequestRepo;
  clock: Clock;
  logger: Logger;
  /** Without it the audit row carries the admin's e-mail but no actor id. */
  users?: UserRepo;
}

export interface ManageAccessRequests {
  listAccessRequests(input: ListAccessRequestsInput): Promise<readonly AccessRequestView[]>;
  decideAccessRequest(input: DecideAccessRequestInput): Promise<AccessDecisionResult>;
}

export function makeManageAccessRequests(
  deps: ManageAccessRequestsDeps,
): ManageAccessRequests {
  return {
    async listAccessRequests(input) {
      const tenantId = requireTenant(input?.tenantId, "listAccessRequests");
      const status = parseFilter(input?.status, tenantId);

      const rows = await deps.requests.list(tenantId, status);
      deps.logger.debug("Access requests listed", {
        tenant_id: tenantId,
        access_filter: status,
        row_count: rows.length,
      });
      return rows.map(toAccessRequestView);
    },

    async decideAccessRequest(input) {
      // --- Edge cases first ---------------------------------------------------
      const tenantId = requireTenant(input?.tenantId, "decideAccessRequest");
      const id = requireId(input?.id, tenantId);
      const decision = input?.decision;
      if (decision !== "approve" && decision !== "block") {
        throw new AppError("INVALID_INPUT", {
          message: `Decision must be one of ${ACCESS_DECISIONS.join(", ")}`,
          userMessage: "Quyết định không hợp lệ (chỉ nhận duyệt hoặc chặn).",
          context: { tenant_id: tenantId, access_request_id: id, field: "decision" },
        });
      }

      /**
       * An approval with no role would write a user nobody can reason about, so
       * it is refused BEFORE anything is written. A block takes no role and
       * clears the stored one — re-approving always names a role anyway.
       */
      const role = decision === "approve" ? requireRole(input?.role, tenantId, id) : null;

      const log = deps.logger.child({ tenant_id: tenantId, access_request_id: id });
      const actorEmail = normaliseEmail(input?.actorEmail);
      const actorUserId = await resolveActorUserId(
        { users: deps.users },
        tenantId,
        { actorEmail },
        log,
      );

      const decided = await deps.requests.decide({
        tenantId,
        id,
        status: decision === "approve" ? "approved" : "blocked",
        role,
        decidedAt: deps.clock.now(),
        decidedByUserId: actorUserId,
        decidedByEmail: actorEmail,
      });

      if (!decided) {
        throw new AppError("ACCESS_REQUEST_NOT_FOUND", {
          message: "No access request with that id in this tenant",
          context: { tenant_id: tenantId, access_request_id: id },
        });
      }

      log.info("Access request decided", {
        access_decision: decision,
        access_status: decided.status,
        access_role: decided.role,
        provider: decided.provider,
        actor_email: actorEmail,
      });

      return { id: decided.id, status: decided.status, role: decided.role };
    },
  };
}

function parseFilter(value: unknown, tenantId: string): AccessListFilter {
  if (value === undefined || value === null || value === "") return "pending";
  if (value === "all" || isAccessStatus(value)) return value;

  throw new AppError("INVALID_INPUT", {
    message: "Unknown access request status filter",
    userMessage: "Bộ lọc trạng thái không hợp lệ.",
    context: { tenant_id: tenantId, field: "status", value: String(value) },
  });
}

function requireRole(value: unknown, tenantId: string, id: string): OperatorRole {
  if (isOperatorRole(value)) return value;

  throw new AppError("INVALID_INPUT", {
    message: `Approving requires one of the roles: ${OPERATOR_ROLES.join(", ")}`,
    userMessage: "Phải chọn vai trò hợp lệ khi duyệt tài khoản.",
    context: { tenant_id: tenantId, access_request_id: id, field: "role" },
  });
}

function requireId(value: unknown, tenantId: string): string {
  const id = typeof value === "string" ? value.trim() : "";
  if (id.length === 0) {
    throw new AppError("INVALID_INPUT", {
      message: "decideAccessRequest requires an access request id",
      userMessage: "Thiếu mã yêu cầu truy cập.",
      context: { tenant_id: tenantId, field: "id" },
    });
  }
  return id;
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
