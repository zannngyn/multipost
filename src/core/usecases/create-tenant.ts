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

/**
 * How many times we try to place a DERIVED slug before refusing.
 *
 * Bounded on purpose (no "loop until free"): a repo that answers SLUG_TAKEN for
 * the wrong reason would spin forever. Five is not a guess — attempt 1 is the
 * bare slug and every later attempt widens the random suffix by one more chunk
 * (4 hex ~ 16 bits each), so the tail probability collapses faster than the
 * tenant count grows. With 3.000 companies sharing one base slug (the shape
 * `ensureDefaultTenant` creates: every default company derives
 * "cong-ty-cua-toi"), attempt 2 misses ~4.5% of the time, attempt 3 ~1e-6, and
 * the whole ladder misses about once in 30 million sign-ups.
 */
export const MAX_DERIVED_SLUG_ATTEMPTS = 5;

/** Base used when a name carries no Latin letters at all ("日本語のみ"). */
const FALLBACK_SLUG_BASE = "cong-ty";

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
  /**
   * Entropy for auto-slug collision suffixes — core owns no crypto. Called once
   * per retry chunk, so a 4-hex generator still reaches 64 bits on the last
   * attempt; its output is sanitised here, never trusted as slug-shaped.
   */
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
     * A slug the OPERATOR chose that is taken → their problem, SLUG_TAKEN, on
     * the first attempt: silently moving them to "their-slug-9f2c" would hand
     * back a company living at an address they did not ask for.
     *
     * A slug WE derived that collides → our problem, and it must never become
     * theirs: `ensureDefaultTenant` provisions companies with no slug at all,
     * so a refusal there is a dead end for an account that has no screen to
     * retry from. Hence the retry ladder below.
     */
    const created: CreatedTenant =
      requestedSlug.length > 0
        ? await deps.onboarding.createTenant(record(requestedSlug))
        : await createWithDerivedSlug(deps, name, record, log);

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

/**
 * Place a slug WE derived, widening the random suffix on every miss.
 *
 * Errors: SLUG_TAKEN from the repo is the retry signal and is logged with the
 * slug that lost; anything else (limits, driver) travels out untouched on the
 * first throw. Exhausting the ladder throws SLUG_DERIVATION_EXHAUSTED with the
 * last refusal as `cause` — refused, but never swallowed.
 */
async function createWithDerivedSlug(
  deps: CreateTenantDeps,
  name: string,
  record: (slug: string) => Parameters<TenantOnboardingRepo["createTenant"]>[0],
  log: Logger,
): Promise<CreatedTenant> {
  const derived = slugify(name);
  const base = derived || FALLBACK_SLUG_BASE;
  // A name that slugifies to nothing has no distinguishing base, so it starts
  // suffixed: the bare "cong-ty" would burn an attempt on a near-certain miss.
  const firstAttempt = derived.length > 0 ? 0 : 1;

  let lastRefusal: AppError | undefined;
  for (let i = 0; i < MAX_DERIVED_SLUG_ATTEMPTS; i += 1) {
    const attempt = firstAttempt + i;
    const slug = attempt === 0 ? base : withSuffix(base, entropy(deps.randomSuffix, attempt));
    try {
      return await deps.onboarding.createTenant(record(slug));
    } catch (error) {
      if (!AppError.is(error) || error.code !== "SLUG_TAKEN") throw error;
      lastRefusal = error;
      log.warn("Derived slug is taken — retrying with a wider suffix", {
        slug,
        attempt: i + 1,
        max_attempts: MAX_DERIVED_SLUG_ATTEMPTS,
        error_code: error.code,
      });
    }
  }

  log.error("Gave up deriving a free slug", {
    slug_base: base,
    attempts: MAX_DERIVED_SLUG_ATTEMPTS,
    error_code: "SLUG_DERIVATION_EXHAUSTED",
  });
  throw new AppError("SLUG_DERIVATION_EXHAUSTED", {
    context: { slug_base: base, attempts: MAX_DERIVED_SLUG_ATTEMPTS },
    cause: lastRefusal,
  });
}

/**
 * `attempt` chunks of entropy, sanitised: the generator is injected, so its
 * output is outside data as far as this layer is concerned. An empty result
 * means the composition root handed us a broken generator — that is a bug in
 * the deployment, not a slug collision, and it gets its own code.
 */
function entropy(randomSuffix: () => string, attempt: number): string {
  let suffix = "";
  for (let i = 0; i < attempt; i += 1) {
    suffix += String(randomSuffix() ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "");
  }
  if (suffix.length === 0) {
    throw new AppError("INTERNAL", {
      message: "randomSuffix produced no usable entropy for slug derivation",
      context: { attempt },
    });
  }
  return suffix.slice(0, SLUG_MAX - 2);
}

/** `base-suffix`, trimmed to the 40-char limit without breaking SLUG_SHAPE. */
function withSuffix(base: string, suffix: string): string {
  const head = base.slice(0, Math.max(0, SLUG_MAX - suffix.length - 1)).replace(/-+$/g, "");
  return head.length > 0 ? `${head}-${suffix}` : suffix;
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
