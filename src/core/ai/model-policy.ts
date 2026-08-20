/**
 * Model policy — pure routing decisions over the registry
 * (docs/ai/model-routing.md §2–3, provider-strategy.md §4).
 *
 * The two escape hatches are NOT the same thing and never share a branch:
 *  - fallback  : infra failure -> different PROVIDER, SAME tier, max 1 per tier;
 *  - escalation: validation failure -> HIGHER tier, max `maxEscalations`.
 */

import { AppError } from "@/core/domain/errors";
import { AI_TIERS } from "@/core/ports/ai";
import type {
  AIFailureKind,
  AITier,
  ModelEntry,
  ModelPolicyOverride,
  ResolvedModelPolicy,
} from "@/core/ports/ai";
import type { TenantId } from "@/core/domain/tenant-context";

/** Tier ladder actually walked for one generation: primary first, then escalations. */
export function tierLadder(policy: ResolvedModelPolicy): AITier[] {
  const escalations = policy.policy.escalate.slice(0, Math.max(0, policy.policy.maxEscalations));
  return [policy.policy.primary, ...escalations];
}

export function modelsInTier(policy: ResolvedModelPolicy, tier: AITier): readonly ModelEntry[] {
  return policy.tiers[tier] ?? [];
}

/** First model of a tier. Throws when the registry cannot serve the tier at all. */
export function selectPrimaryModel(policy: ResolvedModelPolicy, tier: AITier): ModelEntry {
  const entries = modelsInTier(policy, tier);
  const entry = entries[0];
  if (!entry) {
    throw new AppError("MODEL_NOT_CONFIGURED", {
      message: `Registry tier "${tier}" has no model for task "${policy.task}"`,
      context: { task: policy.task, tier, registry_version: policy.registryVersion },
    });
  }
  return entry;
}

/**
 * Next model in the SAME tier from a DIFFERENT provider (infra fallback).
 * Returns null when the tier has no alternative provider left.
 */
export function selectFallbackModel(
  policy: ResolvedModelPolicy,
  tier: AITier,
  usedModelKeys: readonly string[],
): ModelEntry | null {
  const usedProviders = new Set(
    modelsInTier(policy, tier)
      .filter((entry) => usedModelKeys.includes(entry.key))
      .map((entry) => entry.provider),
  );

  for (const entry of modelsInTier(policy, tier)) {
    if (usedModelKeys.includes(entry.key)) continue;
    if (usedProviders.has(entry.provider)) continue;
    return entry;
  }
  return null;
}

/** Infra failures swap provider; quality failures do not. `bad_request` does neither. */
export function shouldFallback(kind: AIFailureKind | undefined): boolean {
  return (
    kind === "timeout" ||
    kind === "rate_limited" ||
    kind === "provider_down" ||
    kind === "content_refused"
  );
}

/** ADR-001 §8: our own malformed request — fail fast, no retry of any kind. */
export function isTerminalFailure(kind: AIFailureKind | undefined): boolean {
  return kind === "bad_request";
}

/** Reads the finer reason an adapter attached to its AppError. */
export function failureKindOf(error: unknown): AIFailureKind | undefined {
  if (!AppError.is(error)) return undefined;
  const kind = error.context.failure_kind;
  return typeof kind === "string" ? (kind as AIFailureKind) : undefined;
}

/**
 * Overlay a per-tenant DB override on the YAML-resolved policy (ADR-001).
 * Pure: the adapter parses + caches, this decides what the merge MEANS.
 *
 * Two hard rules, both enforced here so no store can skip them:
 *  1. `tierModels` may only REFERENCE keys already present in the YAML registry.
 *     A DB row can re-order or restrict providers; it can never introduce a
 *     model string that no PR ever reviewed (model-routing.md §5).
 *  2. The resulting policy must still be walkable — an override that empties the
 *     primary tier is a configuration error, not a silent fallback to default.
 */
export function applyPolicyOverride(
  base: ResolvedModelPolicy,
  override: ModelPolicyOverride,
  context: { tenantId: TenantId },
): ResolvedModelPolicy {
  if (!override || Object.keys(override).length === 0) return base;

  const catalog = new Map<string, ModelEntry>();
  for (const tier of AI_TIERS) {
    for (const entry of base.tiers[tier] ?? []) catalog.set(entry.key, entry);
  }

  const tiers: Record<AITier, readonly ModelEntry[]> = {
    cheap: base.tiers.cheap ?? [],
    mid: base.tiers.mid ?? [],
    top: base.tiers.top ?? [],
  };

  for (const tier of AI_TIERS) {
    const keys = override.tierModels?.[tier];
    if (!keys) continue;

    const entries = keys.map((key) => {
      const entry = catalog.get(key);
      if (!entry) {
        throw new AppError("MODEL_NOT_CONFIGURED", {
          message: `Tenant override for task "${base.task}" references model "${key}" that is not in the YAML registry`,
          userMessage:
            "Cấu hình model riêng của đơn vị trỏ tới model không có trong registry — cần quản trị viên sửa.",
          context: {
            tenant_id: context.tenantId,
            task: base.task,
            tier,
            model_key: key,
            registry_version: base.registryVersion,
          },
        });
      }
      return entry;
    });

    if (entries.length === 0) {
      throw new AppError("MODEL_NOT_CONFIGURED", {
        message: `Tenant override for task "${base.task}" empties tier "${tier}"`,
        context: { tenant_id: context.tenantId, task: base.task, tier },
      });
    }
    tiers[tier] = entries;
  }

  const policy = {
    ...base.policy,
    vision: override.vision ?? base.policy.vision,
    primary: override.primary ?? base.policy.primary,
    escalate: override.escalate ?? base.policy.escalate,
    maxEscalations: override.maxEscalations ?? base.policy.maxEscalations,
    maxOutputTokens: override.maxOutputTokens ?? base.policy.maxOutputTokens,
    timeoutMs: override.timeoutMs ?? base.policy.timeoutMs,
    temperature: override.temperature ?? base.policy.temperature,
  };

  const merged: ResolvedModelPolicy = {
    ...base,
    policy,
    tiers,
    budget: {
      maxCostPerGenerationUsd:
        override.budget?.maxCostPerGenerationUsd ?? base.budget.maxCostPerGenerationUsd,
      dailyCostPerTenantUsd:
        override.budget?.dailyCostPerTenantUsd ?? base.budget.dailyCostPerTenantUsd,
    },
  };

  // Fail here, not on the first generation of the day.
  for (const tier of tierLadder(merged)) selectPrimaryModel(merged, tier);
  return merged;
}

export interface CostInput {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
}

/** Cost of one attempt, from the price table stored in the registry. */
export function estimateCostUsd(entry: ModelEntry, usage: CostInput): number {
  const { pricing } = entry;
  const cachedPrice = pricing.cachedInputPerMTokUsd ?? pricing.inputPerMTokUsd;
  // Cached tokens are billed separately, so they must not be counted twice.
  const billableInput = Math.max(0, usage.inputTokens - usage.cachedTokens);
  const usd =
    (billableInput * pricing.inputPerMTokUsd +
      usage.cachedTokens * cachedPrice +
      usage.outputTokens * pricing.outputPerMTokUsd) /
    1_000_000;
  return Number(usd.toFixed(6));
}

/**
 * Worst-case cost of an attempt BEFORE calling (docs/ai/cost-model.md §3).
 * Input tokens are estimated from prompt characters (~4 chars/token) plus a
 * flat vision allowance, so the ceiling check happens before we spend money.
 */
export const VISION_TOKEN_ALLOWANCE = 1_200;
const CHARS_PER_TOKEN = 4;

export function projectAttemptCostUsd(
  entry: ModelEntry,
  input: { promptChars: number; hasImage: boolean; maxOutputTokens: number },
): number {
  const inputTokens =
    Math.ceil(input.promptChars / CHARS_PER_TOKEN) + (input.hasImage ? VISION_TOKEN_ALLOWANCE : 0);
  return estimateCostUsd(entry, {
    inputTokens,
    outputTokens: input.maxOutputTokens,
    cachedTokens: 0,
  });
}
