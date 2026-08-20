import { AppError } from "@/core/domain/errors";
import type { ClaimInviteResult, InviteRepo } from "@/core/ports/invite-repo";
import type { Clock, Logger } from "@/core/ports/infra";

/**
 * M2.2 — `POST /api/join`: turn an invite token into a membership.
 *
 * Serves the NoMembership state (docs/09 §3.8): NO tenant context here — the
 * tenant comes out of the INVITE row, exactly like the OAuth callback takes
 * its tenant from the state row. The repo does the atomic claim; this usecase
 * owns the input contract and the one-refusal rule:
 *
 * EVERY refusal — unknown token, expired, revoked, used up, suspended tenant —
 * is the same INVITE_INVALID. Distinguishing them would turn /join into an
 * oracle for probing which invites exist; the precise reason goes to the log.
 */

export interface JoinWithInviteInput {
  readonly accountId: string;
  readonly sessionEmail: string;
  readonly displayName?: string | null;
  readonly token: string;
}

export interface JoinWithInviteResult {
  readonly tenant: {
    readonly id: string;
    readonly name: string;
    readonly slug: string | null;
    readonly plan: string;
  };
  readonly role: string;
  /** True = the account was ALREADY a member; no use was burned. */
  readonly alreadyMember: boolean;
}

export interface JoinWithInviteDeps {
  invites: InviteRepo;
  clock: Clock;
  logger: Logger;
  /** Same hash as the creator used — the port only ever sees hashes. */
  hashToken: (token: string) => string;
}

export type JoinWithInvite = (input: JoinWithInviteInput) => Promise<JoinWithInviteResult>;

export function makeJoinWithInvite(deps: JoinWithInviteDeps): JoinWithInvite {
  return async function joinWithInvite(input) {
    // --- Edge cases first ---------------------------------------------------
    const accountId = str(input?.accountId);
    const sessionEmail = str(input?.sessionEmail).toLowerCase();
    if (accountId.length === 0 || sessionEmail.length === 0) {
      throw new AppError("UNAUTHORIZED", {
        message: "joinWithInvite requires a session backed by an account",
      });
    }

    const token = str(input?.token);
    // A token this short cannot have come from us — refuse before hashing, and
    // with the SAME code as every other refusal.
    if (token.length < 32 || token.length > 256) {
      deps.logger.warn("Invite claim refused before lookup", {
        error_code: "INVITE_INVALID",
        reason: "TOKEN_SHAPE",
        token_length: token.length,
      });
      throw inviteInvalid();
    }

    const result: ClaimInviteResult = await deps.invites.claimInvite({
      tokenHash: deps.hashToken(token),
      accountId,
      sessionEmail,
      displayName: str(input?.displayName) || null,
      now: deps.clock.now(),
    });

    if (result.kind === "invalid") {
      // The reason stays server-side (log), the caller gets the one code.
      deps.logger.warn("Invite claim refused", {
        error_code: "INVITE_INVALID",
        reason: result.reason,
        account_id: accountId,
      });
      throw inviteInvalid();
    }

    deps.logger.info(
      result.kind === "already_member"
        ? "Invite opened by an existing member — no use burned"
        : "Invite accepted, membership created",
      {
        tenant_id: result.tenant.id,
        account_id: accountId,
        membership_role: result.role,
        already_member: result.kind === "already_member",
      },
    );

    return {
      tenant: result.tenant,
      role: result.role,
      alreadyMember: result.kind === "already_member",
    };
  };
}

function inviteInvalid(): AppError {
  return new AppError("INVITE_INVALID", {
    message: "Invite token is unknown, expired, revoked or used up",
  });
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
