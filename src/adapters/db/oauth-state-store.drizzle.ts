import { and, eq, gt, isNull } from "drizzle-orm";

import { AppError } from "@/core/domain/errors";
import type {
  ClaimOAuthStateInput,
  ClaimedOAuthState,
  IssueOAuthStateInput,
  OAuthStateStore,
} from "@/core/ports/oauth-state-store";
import type { Logger } from "@/core/ports/infra";

import type { Database } from "./client";
import { wrapDbError } from "./db-errors";
import { oauthStates } from "./schema";

/**
 * `oauth_state` persistence (M1.3b, doc 10 §6).
 *
 * NOT behind `forTenant()` on purpose: the CLAIM is what tells us which tenant
 * the flow belongs to — scoping the lookup by a tenant taken from the request
 * would re-open the exact hole this table closes. The tenant filter of every
 * later statement comes from the claimed row, re-authorised by requireTenant.
 */

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export class DrizzleOAuthStateStore implements OAuthStateStore {
  constructor(
    private readonly db: Database,
    private readonly deps: { logger: Logger },
  ) {}

  async issue(input: IssueOAuthStateInput): Promise<void> {
    // --- Edge cases first ---------------------------------------------------
    const nonceHash = str(input?.nonceHash);
    const accountId = str(input?.accountId);
    if (nonceHash.length < 32 || accountId.length === 0) {
      // A short hash means the caller hashed nothing — refusing here beats
      // storing a state row any guess could claim.
      throw new AppError("INVALID_INPUT", {
        message: "issue requires a real nonce hash and an account id",
        context: { purpose: input?.purpose ?? null, field: "nonceHash" },
      });
    }

    try {
      await this.db.insert(oauthStates).values({
        nonceHash,
        tenantId: input.tenantId,
        accountId,
        purpose: input.purpose,
        expiresAt: input.expiresAt,
      });
      this.deps.logger.info("OAuth state issued", {
        tenant_id: input.tenantId,
        account_id: accountId,
        purpose: input.purpose,
      });
    } catch (error) {
      throw wrapDbError(error, {
        operation: "oauthState.issue",
        tenant_id: input.tenantId,
        purpose: input.purpose,
        field: "nonceHash",
      });
    }
  }

  async claim(input: ClaimOAuthStateInput): Promise<ClaimedOAuthState | null> {
    const nonceHash = str(input?.nonceHash);
    // A missing/garbage nonce is a refusal, not a query for "whoever has ''".
    if (nonceHash.length < 32) return null;

    try {
      /**
       * The single-use guarantee, in ONE statement: only an unused, unexpired
       * row of the right purpose matches, and it leaves the statement already
       * marked used. Two racing callbacks: exactly one gets a row back.
       */
      const rows = await this.db
        .update(oauthStates)
        .set({ usedAt: input.now })
        .where(
          and(
            eq(oauthStates.nonceHash, nonceHash),
            eq(oauthStates.purpose, input.purpose),
            isNull(oauthStates.usedAt),
            gt(oauthStates.expiresAt, input.now),
          ),
        )
        .returning({ tenantId: oauthStates.tenantId, accountId: oauthStates.accountId });

      const row = rows[0];
      if (!row) {
        // One log for all four reasons (unknown / wrong purpose / used /
        // expired): the CALLER must not be able to tell them apart, but the
        // operator log should still show that a claim bounced.
        this.deps.logger.warn("OAuth state claim refused", {
          purpose: input.purpose,
          error_code: "UNAUTHORIZED",
        });
        return null;
      }
      return { tenantId: row.tenantId, accountId: row.accountId };
    } catch (error) {
      throw wrapDbError(error, {
        operation: "oauthState.claim",
        purpose: input.purpose,
        field: "nonceHash",
      });
    }
  }
}
