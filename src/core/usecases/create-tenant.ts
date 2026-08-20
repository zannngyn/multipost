import { AppError } from "@/core/domain/errors";
import type { Clock, Logger } from "@/core/ports/infra";
import type { CreatedTenant, TenantOnboardingRepo } from "@/core/ports/tenant-onboarding";

/**
 * M2.1 — self-service company creation (docs/09 §3.7, doc 10 §4.4). Any
 * signed-in account may create one — the NoMembership state exists precisely
 * to land here — and the creator comes out as OWNER.
 *
 * The abuse limits (lifetime cap + per-hour cap) are counted inside the repo's
 * transaction, not here: counting outside would let two concurrent requests
 * both pass. This usecase owns the NAME/SLUG rules and the input contract.
 */

export const TENANT_NAME_MIN = 2;
export const TENANT_NAME_MAX = 80;
const SLUG_MAX = 40;
const SLUG_SHAPE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

export interface CreateTenantInput {
  readonly accountId: string;
  readonly sessionEmail: string;
  readonly displayName?: string | null;
  readonly name: string;
  readonly slug?: string | null;
}

export interface CreateTenantResult {
  /** `id`, not `tenantId`: the SAME shape `GET /api/me` serves in `tenants[]`. */
  readonly tenant: {
    readonly id: string;
    readonly name: string;
    readonly slug: string;
    readonly plan: string;
    readonly role: "owner";
  };
  readonly activeTenantId: string;
}

export interface CreateTenantDeps {
  onboarding: TenantOnboardingRepo;
  clock: Clock;
  logger: Logger;
  /** Abuse caps (docs/09 §3.7), read from env config by the composition root. */
  limits: { readonly maxCreatedTotal: number; readonly maxCreatedPerHour: number };
  /** Entropy for auto-slug collision suffixes — core owns no crypto. */
  randomSuffix: () => string;
}

export type CreateTenant = (input: CreateTenantInput) => Promise<CreateTenantResult>;

export function makeCreateTenant(deps: CreateTenantDeps): CreateTenant {
  return async function createTenant(input) {
    // --- Edge cases first ---------------------------------------------------
    const accountId = str(input?.accountId);
    const sessionEmail = str(input?.sessionEmail).toLowerCase();
    if (accountId.length === 0 || sessionEmail.length === 0) {
      throw new AppError("UNAUTHORIZED", {
        message: "createTenant requires a session backed by an account",
      });
    }

    const name = str(input?.name);
    if (name.length < TENANT_NAME_MIN || name.length > TENANT_NAME_MAX) {
      throw new AppError("INVALID_INPUT", {
        message: `Tenant name must be ${TENANT_NAME_MIN}-${TENANT_NAME_MAX} characters`,
        userMessage: `Tên công ty phải dài ${TENANT_NAME_MIN}–${TENANT_NAME_MAX} ký tự.`,
        context: { field: "name" },
      });
    }

    const requestedSlug = str(input?.slug).toLowerCase();
    if (requestedSlug.length > 0 && !SLUG_SHAPE.test(requestedSlug)) {
      throw new AppError("INVALID_INPUT", {
        message: "Slug must be lowercase letters/digits/hyphens, 1-40 chars",
        userMessage:
          "Định danh (slug) chỉ gồm chữ thường không dấu, số và dấu gạch ngang, tối đa 40 ký tự.",
        context: { field: "slug" },
      });
    }

    const log = deps.logger.child({ account_id: accountId });
    const now = deps.clock.now();
    const record = (slug: string) => ({
      accountId,
      sessionEmail,
      displayName: str(input?.displayName) || null,
      name,
      slug,
      now,
      maxCreatedTotal: deps.limits.maxCreatedTotal,
      maxCreatedPerHour: deps.limits.maxCreatedPerHour,
    });

    /**
     * A slug the OPERATOR chose that is taken → their problem, SLUG_TAKEN.
     * A slug WE derived that collides → our problem: retry once with a random
     * suffix before giving up, so "Công ty ABC" does not fail because another
     * "cong-ty-abc" exists somewhere.
     */
    let created: CreatedTenant;
    if (requestedSlug.length > 0) {
      created = await deps.onboarding.createTenant(record(requestedSlug));
    } else {
      const derived = slugify(name) || `cong-ty-${deps.randomSuffix()}`;
      try {
        created = await deps.onboarding.createTenant(record(derived));
      } catch (error) {
        if (!AppError.is(error) || error.code !== "SLUG_TAKEN") throw error;
        created = await deps.onboarding.createTenant(
          record(`${derived.slice(0, SLUG_MAX - 5)}-${deps.randomSuffix()}`),
        );
      }
    }

    log.info("Tenant created through self-service", {
      tenant_id: created.tenantId,
      slug: created.slug,
    });

    return {
      tenant: {
        id: created.tenantId,
        name: created.name,
        slug: created.slug,
        plan: created.plan,
        role: "owner",
      },
      activeTenantId: created.tenantId,
    };
  };
}

/** Vietnamese-friendly: fold diacritics (đ→d), keep [a-z0-9-], collapse runs. */
export function slugify(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[đĐ]/g, "d")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX)
    .replace(/-+$/g, "");
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
