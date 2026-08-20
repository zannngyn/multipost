import { AppError } from "@/core/domain/errors";
import type { TenantId } from "@/core/domain/tenant-context";
import type { MemberChangeResult, MemberRepo } from "@/core/ports/member-repo";
import type { Logger } from "@/core/ports/infra";
import { isOperatorRole, type OperatorRole } from "@/shared/operator-access";

/**
 * M2.3 — the members screen's brain. Thin on purpose: the ladder and the
 * LAST_OWNER rule live where they can be transactional (repo + the pure policy
 * in core/domain/member-policy); this usecase owns the input contract and the
 * response shapes.
 */

export interface MemberView {
  readonly membershipId: string;
  readonly accountId: string;
  readonly displayName: string | null;
  readonly email: string | null;
  readonly role: OperatorRole;
  readonly status: "active";
  readonly joinedAt: string;
  /** So the UI can guard "you are about to demote/remove YOURSELF". */
  readonly isYou: boolean;
}

export interface ListMembersInput {
  readonly tenantId: TenantId;
  readonly actorAccountId: string | null;
}

export interface ChangeMemberRoleInput {
  readonly tenantId: TenantId;
  readonly membershipId: string;
  readonly role: unknown;
  readonly actorRole: OperatorRole;
  readonly actorAccountId: string;
  readonly actorEmail: string | null;
}

export interface RemoveMemberInput {
  readonly tenantId: TenantId;
  readonly membershipId: string;
  readonly actorRole: OperatorRole;
  readonly actorAccountId: string;
  readonly actorEmail: string | null;
}

export interface ManageMembersDeps {
  members: MemberRepo;
  logger: Logger;
}

export interface ManageMembers {
  listMembers(input: ListMembersInput): Promise<readonly MemberView[]>;
  changeRole(input: ChangeMemberRoleInput): Promise<MemberChangeResult>;
  removeMember(input: RemoveMemberInput): Promise<MemberChangeResult>;
}

export function makeManageMembers(deps: ManageMembersDeps): ManageMembers {
  return {
    async listMembers(input) {
      const rows = await deps.members.listMembers(input.tenantId);
      return rows.map((row) => ({
        membershipId: row.membershipId,
        accountId: row.accountId,
        displayName: row.displayName,
        email: row.email,
        role: row.role,
        status: "active" as const,
        joinedAt: row.joinedAt.toISOString(),
        isYou: input.actorAccountId !== null && row.accountId === input.actorAccountId,
      }));
    },

    async changeRole(input) {
      // --- Edge case first ---------------------------------------------------
      if (!isOperatorRole(input?.role)) {
        throw new AppError("INVALID_INPUT", {
          message: "changeRole requires one of the known roles",
          userMessage: "Vai trò không hợp lệ.",
          context: { tenant_id: input.tenantId, field: "role" },
        });
      }
      return deps.members.changeRole({
        tenantId: input.tenantId,
        membershipId: input.membershipId,
        newRole: input.role,
        actorRole: input.actorRole,
        actorAccountId: input.actorAccountId,
        actorEmail: input.actorEmail,
      });
    },

    async removeMember(input) {
      return deps.members.removeMember({
        tenantId: input.tenantId,
        membershipId: input.membershipId,
        actorRole: input.actorRole,
        actorAccountId: input.actorAccountId,
        actorEmail: input.actorEmail,
      });
    },
  };
}
