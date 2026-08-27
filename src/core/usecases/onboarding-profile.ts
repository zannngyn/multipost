import { AppError } from "@/core/domain/errors";
import { isTenantId } from "@/core/domain/tenant";
import { normalizeTenantId, type TenantId } from "@/core/domain/tenant-context";
import type { Clock, Logger } from "@/core/ports/infra";
import type { OnboardingProfile, TenantProfileRepo } from "@/core/ports/tenant-profile";

/**
 * E10 — the onboarding survey: read it, save one step of it, finish it.
 *
 * THIS FILE IS THE ONLY GATE. `tenant_profile` deliberately constrains no
 * vocabulary (no pg enum, no check constraint) because the survey will grow
 * options faster than the table can be migrated — see the schema header. The
 * consequence is that a code nobody defined is refused here or it lands in the
 * table forever, and every later reader has to guess what it meant. Nothing is
 * repaired into "the closest valid code": a near miss is a bug in the caller,
 * and silently storing `agency` for `AGENCY` hides it.
 *
 * The three states of an answer are the other invariant, and per-step autosave
 * is what makes them load-bearing:
 *   - key ABSENT  = leave the stored answer alone (saving step 3 must not blank
 *     steps 1 and 2);
 *   - `null`      = clear it — this is what "Bỏ qua" means;
 *   - `[]`        = "none of these", which is an ANSWER and not the same fact
 *     as `null`.
 * An EMPTY patch asserts none of the three, so it throws rather than no-opping:
 * a client that wants to skip a step sends `null` or does not call at all, and
 * a silent no-op would surface later as "câu trả lời không được lưu".
 *
 * Stored values are STABLE CODES, never the Vietnamese labels on screen —
 * rewording a question must not invalidate rows written before the rewording.
 */

/** Step 1 — how the tenant sells. One code. */
export const SELLER_KINDS = [
  "solo_seller",
  "shop_owner",
  "marketing_team",
  "freelancer",
  "agency",
  "other",
] as const;

/** Step 2 — what they post with today. Many codes. */
export const TOOL_KINDS = [
  "manual_facebook",
  "meta_business_suite",
  "smm_tool",
  "platform_specific_tool",
  "ai_platform",
  "other",
] as const;

/**
 * Step 3 — how many pages they manage. BUCKETS, not numbers: the answer is a
 * band the operator picks, and bands never get summed or compared numerically.
 */
export const CHANNEL_COUNTS = ["1-3", "4-6", "7-10", "11-20", "21-50", "50+"] as const;

/**
 * Step 4 — which channels they focus on. Many codes. Everything except
 * `facebook` is unbuilt in phase 1 and is collected as a demand vote, so this
 * list is deliberately WIDER than what the publisher supports.
 */
export const FOCUS_CHANNELS = [
  "facebook",
  "tiktok",
  "instagram",
  "youtube",
  "threads",
  "zalo_oa",
  "shopee",
  "lazada",
] as const;

export type SellerKind = (typeof SELLER_KINDS)[number];
export type ToolKind = (typeof TOOL_KINDS)[number];
export type ChannelCount = (typeof CHANNEL_COUNTS)[number];
export type FocusChannel = (typeof FOCUS_CHANNELS)[number];

/**
 * A list longer than this is not an operator picking options — every list here
 * has at most eight members, so anything past the cap is a client bug or an
 * attempt to make the repo write a huge array. Refused BEFORE de-duplication,
 * so a flood of repeats cannot slip through by collapsing to one item.
 */
const MAX_LIST_LENGTH = 64;

/** Only the four answer fields. `completedAt` is `completeOnboarding`'s alone. */
export interface OnboardingProfilePatchInput {
  readonly sellerKind?: string | null;
  readonly currentTools?: readonly string[] | null;
  readonly channelCount?: string | null;
  readonly focusChannels?: readonly string[] | null;
}

const ANSWER_KEYS = ["sellerKind", "currentTools", "channelCount", "focusChannels"] as const;
type AnswerKey = (typeof ANSWER_KEYS)[number];

const SINGLE_VOCABULARY: Record<"sellerKind" | "channelCount", readonly string[]> = {
  sellerKind: SELLER_KINDS,
  channelCount: CHANNEL_COUNTS,
};

const LIST_VOCABULARY: Record<"currentTools" | "focusChannels", readonly string[]> = {
  currentTools: TOOL_KINDS,
  focusChannels: FOCUS_CHANNELS,
};

export interface GetOnboardingProfileInput {
  readonly tenantId: TenantId;
}

export interface SaveOnboardingProfileInput {
  readonly tenantId: TenantId;
  readonly patch: OnboardingProfilePatchInput;
}

export interface CompleteOnboardingInput {
  readonly tenantId: TenantId;
}

export type GetOnboardingProfile = (input: GetOnboardingProfileInput) => Promise<OnboardingProfile>;
export type SaveOnboardingProfile = (input: SaveOnboardingProfileInput) => Promise<OnboardingProfile>;
export type CompleteOnboarding = (input: CompleteOnboardingInput) => Promise<OnboardingProfile>;

export interface OnboardingProfileDeps {
  profiles: TenantProfileRepo;
  logger: Logger;
}

export interface CompleteOnboardingDeps extends OnboardingProfileDeps {
  clock: Clock;
}

/** What a tenant who never answered anything looks like. Not an error. */
const UNANSWERED: OnboardingProfile = {
  sellerKind: null,
  currentTools: null,
  channelCount: null,
  focusChannels: null,
  completedAt: null,
};

function invalidInput(message: string, userMessage: string, context: Record<string, unknown>): AppError {
  return new AppError("INVALID_INPUT", { message, userMessage, context });
}

/** The tenant id is branded, but a brand is a compile-time marker, not a check. */
function requireTenantId(operation: string, tenantId: TenantId): TenantId {
  const raw = typeof tenantId === "string" ? tenantId.trim() : "";
  if (!isTenantId(raw)) {
    throw invalidInput(`${operation} requires a tenant UUID`, "Mã đơn vị (tenant) không hợp lệ.", {
      tenant_id: raw || null,
      operation,
    });
  }
  return normalizeTenantId(tenantId);
}

function rejectCode(tenantId: TenantId, field: AnswerKey, value: unknown, allowed: readonly string[]): AppError {
  return invalidInput(
    `Unknown onboarding survey code for ${field}`,
    "Lựa chọn không hợp lệ. Vui lòng tải lại trang và chọn lại.",
    {
      tenant_id: tenantId,
      operation: "saveOnboardingProfile",
      field,
      // The rejected value is logged so "vì sao câu trả lời này không lưu" is
      // answerable without reproducing the request.
      rejected_value: typeof value === "string" ? value : typeof value,
      allowed,
    },
  );
}

function checkSingle(tenantId: TenantId, field: "sellerKind" | "channelCount", value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !SINGLE_VOCABULARY[field].includes(value)) {
    // An empty string lands here too, on purpose: "no answer" is spelled null.
    throw rejectCode(tenantId, field, value, SINGLE_VOCABULARY[field]);
  }
  return value;
}

/** Validates, then de-duplicates KEEPING the order the operator picked in. */
function checkList(
  tenantId: TenantId,
  field: "currentTools" | "focusChannels",
  value: unknown,
): readonly string[] | null {
  if (value === null) return null;
  if (!Array.isArray(value)) throw rejectCode(tenantId, field, value, LIST_VOCABULARY[field]);
  if (value.length > MAX_LIST_LENGTH) {
    throw invalidInput(
      `Too many onboarding survey codes for ${field}`,
      "Bạn đã chọn quá nhiều mục. Vui lòng tải lại trang và chọn lại.",
      { tenant_id: tenantId, operation: "saveOnboardingProfile", field, count: value.length },
    );
  }

  const allowed = LIST_VOCABULARY[field];
  const unique: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !allowed.includes(item)) throw rejectCode(tenantId, field, item, allowed);
    // Insertion order is the operator's pick order and is what step 4 renders.
    if (!unique.includes(item)) unique.push(item);
  }
  return unique;
}

export function makeGetOnboardingProfile(deps: OnboardingProfileDeps): GetOnboardingProfile {
  return async function getOnboardingProfile(input) {
    const tenantId = requireTenantId("getOnboardingProfile", input?.tenantId);

    // A repo failure is NOT "chưa trả lời" — it goes up, so the screen shows an
    // error instead of restarting a survey the tenant already finished.
    const stored = await deps.profiles.get(tenantId);
    return stored ?? UNANSWERED;
  };
}

export function makeSaveOnboardingProfile(deps: OnboardingProfileDeps): SaveOnboardingProfile {
  return async function saveOnboardingProfile(input) {
    // --- Edge cases first (CLAUDE.md technical rule 1) ----------------------
    const tenantId = requireTenantId("saveOnboardingProfile", input?.tenantId);

    const patch: unknown = input?.patch;
    if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
      throw invalidInput("saveOnboardingProfile requires a patch object", "Dữ liệu gửi lên không hợp lệ.", {
        tenant_id: tenantId,
        operation: "saveOnboardingProfile",
        field: "patch",
      });
    }

    const given = patch as Record<string, unknown>;
    // `completedAt` is refused here as an unknown key on purpose: finishing the
    // survey is `completeOnboarding`'s decision, not something a step save may
    // smuggle in.
    const unknownKeys = Object.keys(given).filter((key) => !(ANSWER_KEYS as readonly string[]).includes(key));
    if (unknownKeys.length > 0) {
      throw invalidInput("saveOnboardingProfile received unknown fields", "Dữ liệu gửi lên không hợp lệ.", {
        tenant_id: tenantId,
        operation: "saveOnboardingProfile",
        unknown_fields: unknownKeys,
      });
    }

    const writes: Record<string, unknown> = {};
    // Only keys the caller actually sent: `undefined` never becomes `null`, or
    // saving step 3 would blank steps 1 and 2.
    if (given.sellerKind !== undefined) writes.sellerKind = checkSingle(tenantId, "sellerKind", given.sellerKind);
    if (given.currentTools !== undefined) writes.currentTools = checkList(tenantId, "currentTools", given.currentTools);
    if (given.channelCount !== undefined) {
      writes.channelCount = checkSingle(tenantId, "channelCount", given.channelCount);
    }
    if (given.focusChannels !== undefined) {
      writes.focusChannels = checkList(tenantId, "focusChannels", given.focusChannels);
    }

    if (Object.keys(writes).length === 0) {
      throw invalidInput(
        "saveOnboardingProfile received an empty patch",
        "Không có câu trả lời nào để lưu.",
        { tenant_id: tenantId, operation: "saveOnboardingProfile", field: "patch" },
      );
    }

    const saved = await deps.profiles.upsert(tenantId, writes);
    deps.logger.info("Onboarding survey step saved", {
      tenant_id: tenantId,
      fields: Object.keys(writes),
    });
    return saved;
  };
}

export function makeCompleteOnboarding(deps: CompleteOnboardingDeps): CompleteOnboarding {
  return async function completeOnboarding(input) {
    const tenantId = requireTenantId("completeOnboarding", input?.tenantId);

    const stored = await deps.profiles.get(tenantId);
    if (stored?.completedAt) {
      /*
       * Idempotent: the ORIGINAL moment is kept. The last step both saves and
       * finishes, so a double submit or a retry after a flaky response would
       * otherwise rewrite the real completion time — and that timestamp is what
       * decides whether the survey is ever shown again.
       *
       * Two tabs finishing at the same instant can still both see "not finished"
       * and both write; the loser writes a timestamp a few milliseconds later,
       * which changes no decision anywhere.
       */
      deps.logger.debug("Onboarding survey already complete — keeping the original moment", {
        tenant_id: tenantId,
        completed_at: stored.completedAt.toISOString(),
      });
      return stored;
    }

    const finished = await deps.profiles.upsert(tenantId, { completedAt: deps.clock.now() });
    deps.logger.info("Onboarding survey completed", {
      tenant_id: tenantId,
      completed_at: finished.completedAt?.toISOString() ?? null,
    });
    return finished;
  };
}
