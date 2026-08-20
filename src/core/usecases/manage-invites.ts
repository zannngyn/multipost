import { roleAtLeast } from "@/core/domain/account";
import { AppError } from "@/core/domain/errors";
import type { TenantId } from "@/core/domain/tenant-context";
import type { InviteListItem, InviteRepo } from "@/core/ports/invite-repo";
import type { Clock, Logger } from "@/core/ports/infra";
import { isOperatorRole, type OperatorRole } from "@/shared/operator-access";

/**
 * M2.2 — invite links, the admin half (docs/09 §3.6, doc 10 §4.4).
 *
 * The anti-escalation ladder is enforced HERE, on the server, against the
 * INVITER's role from the authorised tenant context — the client never gets to
 * name an accepted role:
 *   - admin  → may grant editor / viewer only;
 *   - owner  → may grant any role, owner included.
 *
 * The raw token appears exactly ONCE, in the create response. The list never
 * carries it (the DB holds only a hash), so a leaked screen of the invite list
 * admits nobody.
 */

/** 7 days — long enough to onboard a colleague, short enough not to linger. */
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Single-use by default (docs/09 §3.6). */
const INVITE_MAX_USES = 1;

const GRANTABLE_BY_ADMIN: readonly OperatorRole[] = ["editor", "viewer"];

export interface ListInvitesInput {
  readonly tenantId: TenantId;
}

export interface CreateInviteInput {
  readonly tenantId: TenantId;
  /** Role of the INVITER, from the authorised tenant context — never the body. */
  readonly inviterRole: OperatorRole;
  readonly inviterAccountId: string;
  readonly inviterEmail: string | null;
  /** Role the invite grants. */
  readonly role: unknown;
}

export interface CreateInviteResult {
  readonly id: string;
  readonly role: OperatorRole;
  /** The ONE appearance of the raw token. */
  readonly token: string;
  readonly expiresAt: Date;
}

export interface RevokeInviteInput {
  readonly tenantId: TenantId;
  readonly id: string;
  readonly actorAccountId: string | null;
  readonly actorEmail: string | null;
}

export interface ManageInvitesDeps {
  invites: InviteRepo;
  clock: Clock;
  logger: Logger;
  /** ≥128-bit random token — core owns no crypto (docs/07 §2). */
  newToken: () => string;
  /** sha256 hex of a token; the only shape the port ever sees. */
  hashToken: (token: string) => string;
}

export interface ManageInvites {
  listInvites(input: ListInvitesInput): Promise<readonly InviteListItem[]>;
  createInvite(input: CreateInviteInput): Promise<CreateInviteResult>;
  revokeInvite(input: RevokeInviteInput): Promise<{ id: string; revoked: true }>;
}

export function makeManageInvites(deps: ManageInvitesDeps): ManageInvites {
  return {
    async listInvites(input) {
      return deps.invites.listInvites(input.tenantId);
    },

    async createInvite(input) {
      // --- Edge cases first -------------------------------------------------
      const role = input?.role;
      if (!isOperatorRole(role)) {
        throw new AppError("INVALID_INPUT", {
          message: "Invite must grant one of the known roles",
          userMessage: "Vai trò của link mời không hợp lệ.",
          context: { tenant_id: input.tenantId, field: "role" },
        });
      }

      /**
       * The ladder (doc 10 §4.4, revised after gate): granting admin/owner is
       * OWNER work; an admin may only grant editor/viewer. Checked against the
       * membership role the route already authorised — a forged body cannot
       * outrank it.
       */
      const inviterIsOwner = input.inviterRole === "owner";
      if (!inviterIsOwner && !GRANTABLE_BY_ADMIN.includes(role)) {
        deps.logger.warn("Invite refused: inviter's role may not grant this role", {
          tenant_id: input.tenantId,
          error_code: "INVITE_ROLE_FORBIDDEN",
          inviter_role: input.inviterRole,
          requested_role: role,
          alert: "OPERATOR_ATTENTION",
        });
        throw new AppError("INVITE_ROLE_FORBIDDEN", {
          message: `Role '${input.inviterRole}' may not grant '${role}'`,
          context: { tenant_id: input.tenantId, requested_role: role },
        });
      }
      // Defence in depth: even an owner must hold at least the role granted.
      if (!roleAtLeast(input.inviterRole, role)) {
        throw new AppError("INVITE_ROLE_FORBIDDEN", {
          message: "Nobody may grant a role above their own",
          context: { tenant_id: input.tenantId, requested_role: role },
        });
      }

      const token = deps.newToken();
      if (token.length < 32) {
        // <128 bits would make the /join lookup guessable — refuse loudly.
        throw new AppError("INTERNAL", {
          message: "Generated invite token is too short",
          context: { tenant_id: input.tenantId, token_length: token.length },
        });
      }

      const expiresAt = new Date(deps.clock.nowMs() + INVITE_TTL_MS);
      const created = await deps.invites.createInvite({
        tenantId: input.tenantId,
        role,
        tokenHash: deps.hashToken(token),
        expiresAt,
        maxUses: INVITE_MAX_USES,
        createdByAccountId: input.inviterAccountId,
        actorEmail: input.inviterEmail,
      });

      deps.logger.info("Invite created", {
        tenant_id: input.tenantId,
        invite_id: created.id,
        invite_role: role,
      });

      return { id: created.id, role, token, expiresAt };
    },

    async revokeInvite(input) {
      const outcome = await deps.invites.revokeInvite({
        tenantId: input.tenantId,
        id: input.id,
        revokedAt: deps.clock.now(),
        actorAccountId: input.actorAccountId,
        actorEmail: input.actorEmail,
      });

      // Unknown id in THIS tenant behaves as absent (doc 10 §3, 404-semantics).
      if (outcome === "not_found") {
        throw new AppError("INVITE_INVALID", {
          message: "No invite with that id in this tenant",
          context: { tenant_id: input.tenantId, invite_id: input.id },
        });
      }

      // `already_revoked` is a success too — revoking twice must not error.
      deps.logger.info("Invite revoked", {
        tenant_id: input.tenantId,
        invite_id: input.id,
        idempotent_repeat: outcome === "already_revoked",
      });
      return { id: input.id, revoked: true };
    },
  };
}
