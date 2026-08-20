import { AppError } from "@/core/domain/errors";
import type { TenantId } from "@/core/domain/tenant-context";
import type { InviteRepo } from "@/core/ports/invite-repo";
import type { Clock, Logger } from "@/core/ports/infra";
import type {
  PlatformTenantListItem,
  PlatformTenantRepo,
  SetTenantStatusResult,
} from "@/core/ports/platform-tenant-repo";

import { slugify } from "./create-tenant";
import { INVITE_TTL_MS } from "./manage-invites";

/**
 * M3.2 — platform tenant administration. The business flow this exists for:
 * "khách ký hợp đồng → MYSP tạo tenant → gửi link owner cho chủ shop" — so
 * creation mints NO membership (staff are not members of a customer's company)
 * and hands back a single-use OWNER invite instead (M2.2 infrastructure).
 *
 * NO abuse caps here on purpose: 3-per-account/1-per-hour are the SELF-SERVICE
 * boundary (docs/09 §3.7); a super_admin provisioning customers is the boundary
 * enforcement, not its subject.
 */

const SLUG_MAX = 40;
const SLUG_SHAPE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

export interface PlatformCreateTenantInput {
  readonly name: string;
  readonly slug?: string | null;
  readonly plan?: "internal" | "standard" | null;
  readonly actorAccountId: string;
  readonly actorEmail: string | null;
}

export interface PlatformCreateTenantResult {
  readonly tenant: {
    readonly id: TenantId;
    readonly name: string;
    readonly slug: string;
    readonly plan: string;
    readonly status: string;
  };
  /** The ONE appearance of the owner-invite token. */
  readonly ownerInviteToken: string;
  readonly inviteExpiresAt: Date;
}

export interface SetTenantStatusInput {
  readonly tenantId: TenantId;
  readonly status: "active" | "suspended";
  readonly reason: string;
  readonly actorAccountId: string;
  readonly actorEmail: string | null;
}

export interface PlatformTenants {
  listTenants(): Promise<readonly PlatformTenantListItem[]>;
  createTenant(input: PlatformCreateTenantInput): Promise<PlatformCreateTenantResult>;
  setTenantStatus(input: SetTenantStatusInput): Promise<SetTenantStatusResult>;
}

export interface PlatformTenantsDeps {
  platformTenants: PlatformTenantRepo;
  invites: InviteRepo;
  clock: Clock;
  logger: Logger;
  newToken: () => string;
  hashToken: (token: string) => string;
  randomSuffix: () => string;
}

export function makePlatformTenants(deps: PlatformTenantsDeps): PlatformTenants {
  return {
    async listTenants() {
      return deps.platformTenants.listTenants();
    },

    async createTenant(input) {
      // --- Edge cases first -------------------------------------------------
      const name = typeof input?.name === "string" ? input.name.trim() : "";
      if (name.length < 2 || name.length > 80) {
        throw new AppError("INVALID_INPUT", {
          message: "Tenant name must be 2-80 characters",
          userMessage: "Tên công ty phải dài 2–80 ký tự.",
          context: { field: "name" },
        });
      }
      const requestedSlug =
        typeof input?.slug === "string" ? input.slug.trim().toLowerCase() : "";
      if (requestedSlug.length > 0 && !SLUG_SHAPE.test(requestedSlug)) {
        throw new AppError("INVALID_INPUT", {
          message: "Slug must be lowercase letters/digits/hyphens, 1-40 chars",
          userMessage:
            "Định danh (slug) chỉ gồm chữ thường không dấu, số và dấu gạch ngang, tối đa 40 ký tự.",
          context: { field: "slug" },
        });
      }
      const plan = input?.plan ?? "standard";

      const record = (slug: string) => ({
        name,
        slug,
        plan,
        actorAccountId: input.actorAccountId,
        actorEmail: input.actorEmail,
      });

      // Same slug discipline as self-service: a CHOSEN slug that is taken is
      // the caller's SLUG_TAKEN; a DERIVED one retries once with a suffix.
      let tenant;
      if (requestedSlug.length > 0) {
        tenant = await deps.platformTenants.createTenant(record(requestedSlug));
      } else {
        const derived = slugify(name) || `cong-ty-${deps.randomSuffix()}`;
        try {
          tenant = await deps.platformTenants.createTenant(record(derived));
        } catch (error) {
          if (!AppError.is(error) || error.code !== "SLUG_TAKEN") throw error;
          tenant = await deps.platformTenants.createTenant(
            record(`${derived.slice(0, SLUG_MAX - 5)}-${deps.randomSuffix()}`),
          );
        }
      }

      /**
       * The OWNER invite — the handover artefact. Single-use, 7 days, created
       * by the super_admin (so the invite list of the new tenant names who at
       * MYSP provisioned it).
       */
      const token = deps.newToken();
      if (token.length < 32) {
        throw new AppError("INTERNAL", {
          message: "Generated owner-invite token is too short",
          context: { tenant_id: tenant.id },
        });
      }
      const inviteExpiresAt = new Date(deps.clock.nowMs() + INVITE_TTL_MS);
      await deps.invites.createInvite({
        tenantId: tenant.id,
        role: "owner",
        tokenHash: deps.hashToken(token),
        expiresAt: inviteExpiresAt,
        maxUses: 1,
        createdByAccountId: input.actorAccountId,
        actorEmail: input.actorEmail,
      });

      deps.logger.info("Platform tenant provisioned with an owner invite", {
        tenant_id: tenant.id,
        slug: tenant.slug,
        plan,
      });

      return { tenant, ownerInviteToken: token, inviteExpiresAt };
    },

    async setTenantStatus(input) {
      // --- Edge case first: a heavy switch must carry its why ---------------
      const reason = typeof input?.reason === "string" ? input.reason.trim() : "";
      if (reason.length < 10) {
        throw new AppError("INVALID_INPUT", {
          message: "Suspend/activate requires a reason of at least 10 characters",
          userMessage: "Phải ghi lý do (ít nhất 10 ký tự) khi khoá/mở công ty.",
          context: { tenant_id: input?.tenantId ?? null, field: "reason" },
        });
      }

      return deps.platformTenants.setStatus({
        tenantId: input.tenantId,
        status: input.status,
        reason,
        actorAccountId: input.actorAccountId,
        actorEmail: input.actorEmail,
      });
    },
  };
}
