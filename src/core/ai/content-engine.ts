/**
 * ContentEngine implementation — the AI gateway (ADR-001, docs/ai/architecture.md §5).
 *
 * Orchestration only, zero SDK: registry -> prompt -> provider port -> 4-stage
 * validation -> fallback (infra) / escalation (quality) -> generation log.
 *
 * Two failure roads, never merged (provider-strategy.md §4):
 *   infra   (timeout/rate limit/down/refused) -> other PROVIDER, SAME tier, once;
 *   quality (validation failed)               -> HIGHER tier, prompt carries the reasons.
 * `bad_request` takes neither road: it is our bug, so it fails immediately.
 */

import { AppError } from "@/core/domain/errors";
import { captionToneInstruction, DEFAULT_CAPTION_TONE } from "@/shared/caption-tone";
import { hashParts } from "@/core/ai/hash";
import { buildPromptVariables, toWhitelistedProduct } from "@/core/ai/context";
import { GENERATED_CONTENT_JSON_SCHEMA } from "@/core/ai/generated-content";
import {
  estimateCostUsd,
  failureKindOf,
  isTerminalFailure,
  projectAttemptCostUsd,
  selectFallbackModel,
  selectPrimaryModel,
  shouldFallback,
  tierLadder,
} from "@/core/ai/model-policy";
import { assertTemplateValid, renderPrompt } from "@/core/ai/prompt-render";
import { validateGeneratedContent, type PipelineResult } from "@/core/ai/validation";
import type { ValidationContext, ValidationFailure } from "@/core/ai/validation/types";
import type { CaptionInput } from "@/core/domain/caption";
import type {
  AIProviderAdapter,
  AIProviderName,
  AITier,
  GenerationLog,
  GenerationLogEntry,
  IdGenerator,
  ModelPolicyStore,
  NormalizedMessage,
  NormalizedPart,
  PromptStore,
  PromptTemplate,
  ResolvedModelPolicy,
} from "@/core/ports/ai";
import type { Clock, Logger } from "@/core/ports/infra";
import type {
  ContentEngine,
  ContentGenerationAttemptInfo,
  ContentGenerationRequest,
  ContentGenerationResult,
} from "@/core/ports/content-engine";
import { normalizeTenantId, type TenantId } from "@/core/domain/tenant-context";

export interface ContentEngineDeps {
  /** Wired in composition; a tier referencing an absent provider is a config error. */
  providers: Partial<Record<AIProviderName, AIProviderAdapter>>;
  policies: ModelPolicyStore;
  prompts: PromptStore;
  generationLog: GenerationLog;
  logger: Logger;
  clock: Clock;
  ids: IdGenerator;
}

export function makeContentEngine(deps: ContentEngineDeps): ContentEngine {
  return { generate: (request) => generate(deps, request) };
}

async function generate(
  deps: ContentEngineDeps,
  request: ContentGenerationRequest,
): Promise<ContentGenerationResult> {
  // --- Edge cases first (CLAUDE.md rule 1) ---------------------------------
  const rawTenantId = typeof request?.tenantId === "string" ? request.tenantId.trim() : "";
  if (!rawTenantId) {
    throw new AppError("INVALID_INPUT", {
      message: "ContentGenerationRequest.tenantId is required",
      userMessage: "Thiếu mã đơn vị (tenant) khi yêu cầu sinh nội dung.",
      context: { task: request?.task ?? null },
    });
  }
  const tenantId = normalizeTenantId(request.tenantId);
  if (!request.task) {
    throw new AppError("INVALID_INPUT", {
      message: "ContentGenerationRequest.task is required",
      userMessage: "Thiếu loại tác vụ AI cần chạy.",
      context: { tenant_id: tenantId },
    });
  }

  // Strips anything outside the prompt whitelist before a byte reaches a model.
  const product: CaptionInput = toWhitelistedProduct(request.product);

  const generationId = deps.ids.newId();
  const log = deps.logger.child({
    tenant_id: tenantId,
    generation_id: generationId,
    task: request.task,
    platform: request.platform,
    channel: request.channelId,
    job_id: request.postJobId,
    batch_id: request.batchId,
    product_code: request.productCode,
  });

  const policy = await deps.policies.getPolicy({ tenantId, task: request.task });

  const template = await deps.prompts.getActive({
    tenantId,
    task: request.task,
    platform: request.platform,
  });
  if (!template) {
    log.error("Prompt template missing for task", { error_code: "PROMPT_NOT_FOUND" });
    throw new AppError("PROMPT_NOT_FOUND", {
      context: { tenant_id: tenantId, task: request.task, platform: request.platform },
    });
  }
  assertTemplateValid(template);

  const validationContext: ValidationContext = {
    product,
    constraints: request.constraints,
    existingCaptions: request.existingCaptions ?? [],
    // Stage 3 checks claims against the TENANT's columns; absent = MYSP preset.
    fieldMap: request.fieldMap,
  };

  const ladder = tierLadder(policy);
  const state: RunState = {
    attemptNo: 0,
    totalCostUsd: 0,
    totalLatencyMs: 0,
    fallbackUsedAnywhere: false,
    escalations: 0,
    trail: [],
    previousFailures: [],
    lastValidation: undefined,
    escalationFrom: null,
  };

  for (let tierIndex = 0; tierIndex < ladder.length; tierIndex += 1) {
    const outcome = await runTier(deps, {
      tier: ladder[tierIndex],
      policy,
      template,
      request,
      product,
      tenantId,
      generationId,
      validationContext,
      state,
      log,
    });

    if (outcome.kind === "passed") return outcome.result;
    // Quality failure -> escalate one tier, carrying the reasons into the prompt.
    state.escalationFrom = state.attemptNo;
    if (tierIndex < ladder.length - 1) state.escalations += 1;
  }

  // --- All tiers exhausted: never publish, hand it to a human --------------
  const failures = state.previousFailures;
  const stage = state.lastValidation?.firstFailedStage;
  const failureSummary = failures.map((item) => ({ stage: item.stage, rule: item.rule }));

  log.error("AI generation exhausted every tier without passing validation", {
    error_code: stage === 1 ? "AI_RESPONSE_INVALID" : "CAPTION_VALIDATION_FAILED",
    attempts: state.attemptNo,
    escalations: state.escalations,
    fallback_used: state.fallbackUsedAnywhere,
    total_cost_usd: state.totalCostUsd,
    failures: failureSummary,
  });

  if (stage === 1) {
    // Raw model output stays out of the error: it goes to the generation log only.
    throw new AppError("AI_RESPONSE_INVALID", {
      context: {
        tenant_id: tenantId,
        generation_id: generationId,
        task: request.task,
        attempts: state.attemptNo,
        failures: failureSummary,
      },
    });
  }

  throw new AppError("CAPTION_VALIDATION_FAILED", {
    context: {
      tenant_id: tenantId,
      generation_id: generationId,
      task: request.task,
      attempts: state.attemptNo,
      escalations: state.escalations,
      failures: failures.map((item) => ({
        stage: item.stage,
        rule: item.rule,
        message: item.message,
      })),
    },
  });
}

// ---------------------------------------------------------------------------
// One tier = one model, plus at most one provider fallback inside that tier
// ---------------------------------------------------------------------------

interface RunState {
  attemptNo: number;
  totalCostUsd: number;
  totalLatencyMs: number;
  fallbackUsedAnywhere: boolean;
  escalations: number;
  trail: ContentGenerationAttemptInfo[];
  previousFailures: ValidationFailure[];
  lastValidation: PipelineResult | undefined;
  escalationFrom: number | null;
}

interface TierRunInput {
  tier: AITier;
  policy: ResolvedModelPolicy;
  template: PromptTemplate;
  request: ContentGenerationRequest;
  product: CaptionInput;
  tenantId: TenantId;
  generationId: string;
  validationContext: ValidationContext;
  state: RunState;
  log: Logger;
}

type TierOutcome =
  | { kind: "passed"; result: ContentGenerationResult }
  | { kind: "quality_failed" };

async function runTier(deps: ContentEngineDeps, input: TierRunInput): Promise<TierOutcome> {
  const { tier, policy, template, request, product, tenantId, generationId, state, log } = input;

  let entry = selectPrimaryModel(policy, tier);
  const usedModelKeys: string[] = [];
  let fallbackUsedInTier = false;

  for (;;) {
    usedModelKeys.push(entry.key);
    state.attemptNo += 1;
    const attemptNo = state.attemptNo;

    const variables = buildPromptVariables({
      request,
      product,
      previousFailures: state.previousFailures,
    });
    const userPrompt = renderPrompt(template.userPromptTemplate, variables);
    const inputHash = hashParts({
      name: product.name,
      description: product.description,
      category: product.category,
      season: product.season,
      image: request.vision.mode === "single" ? request.vision.image.ref : "",
      template: template.id,
      version: template.version,
      // Two tones are NOT the same input: without this, `ai_generation` would
      // claim identical inputs for prompts that differ. Added conditionally so
      // the default tone keeps producing exactly the hashes it produced before.
      ...(captionToneInstruction(request.tone) ? { tone: String(request.tone) } : {}),
    });

    const attemptLog = log.child({
      attempt_no: attemptNo,
      provider: entry.provider,
      model: entry.model,
      tier,
      // `ai_generation` has no tone column (no migration in this change), so the
      // log line is where "which tone produced this caption" is answered.
      tone: request.tone ?? DEFAULT_CAPTION_TONE,
    });

    // --- budget ceiling BEFORE spending (docs/ai/cost-model.md §3) ---------
    const projectedCost = projectAttemptCostUsd(entry, {
      promptChars: template.systemPrompt.length + userPrompt.length,
      hasImage: request.vision.mode !== "none",
      maxOutputTokens: policy.policy.maxOutputTokens,
    });
    if (state.totalCostUsd + projectedCost > policy.budget.maxCostPerGenerationUsd) {
      attemptLog.error("AI generation stopped: per-generation budget ceiling reached", {
        error_code: "AI_BUDGET_EXCEEDED",
        spent_usd: state.totalCostUsd,
        projected_usd: projectedCost,
        ceiling_usd: policy.budget.maxCostPerGenerationUsd,
      });
      throw new AppError("AI_BUDGET_EXCEEDED", {
        context: {
          tenant_id: tenantId,
          generation_id: generationId,
          task: request.task,
          tier,
          provider: entry.provider,
          model: entry.model,
          spent_usd: state.totalCostUsd,
          projected_usd: projectedCost,
          ceiling_usd: policy.budget.maxCostPerGenerationUsd,
        },
      });
    }

    const provider = deps.providers[entry.provider];
    if (!provider) {
      attemptLog.error("Registry references a provider that is not wired", {
        error_code: "MODEL_NOT_CONFIGURED",
      });
      throw new AppError("MODEL_NOT_CONFIGURED", {
        message: `No adapter wired for provider "${entry.provider}"`,
        context: { provider: entry.provider, model: entry.model, tier, task: request.task },
      });
    }

    const baseLogEntry = {
      generationId,
      attemptNo,
      requestId: request.requestId,
      tenantId,
      task: request.task,
      postJobId: request.postJobId,
      channelId: request.channelId,
      batchId: request.batchId,
      productCode: request.productCode,
      promptTemplateId: template.id,
      promptVersion: template.version,
      provider: entry.provider,
      model: entry.model,
      tier,
      fallbackUsed: fallbackUsedInTier,
      escalationFrom: state.escalationFrom,
      inputHash,
      createdAt: deps.clock.now().toISOString(),
    };

    let response;
    try {
      response = await provider.complete({
        model: entry.model,
        system: template.systemPrompt,
        messages: [buildMessage(userPrompt, request)],
        outputSchema: GENERATED_CONTENT_JSON_SCHEMA,
        maxOutputTokens: policy.policy.maxOutputTokens,
        timeoutMs: policy.policy.timeoutMs,
        // Sending a temperature to a model that rejects the parameter is a 400,
        // classified `bad_request` — terminal, no retry, no escalation. The task
        // keeps stating the temperature it WANTS; the model decides whether it
        // can be honoured.
        temperature: entry.capabilities.temperature ? policy.policy.temperature : undefined,
        metadata: { generationId, task: request.task, tenantId },
      });
    } catch (error) {
      const appError = AppError.from(error, "AI_PROVIDER_ERROR", {
        tenant_id: tenantId,
        generation_id: generationId,
        task: request.task,
        provider: entry.provider,
        model: entry.model,
        tier,
        attempt_no: attemptNo,
      });
      const kind = failureKindOf(appError);

      await recordAttempt(deps, attemptLog, {
        ...baseLogEntry,
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        latencyMs: 0,
        estimatedCostUsd: 0,
        success: false,
        errorCode: appError.code,
        failureKind: kind,
      });

      attemptLog.error("AI provider call failed", {
        error_code: appError.code,
        failure_kind: kind ?? null,
        err: appError,
      });

      // Our own malformed request — retrying anything would just burn money.
      if (isTerminalFailure(kind)) throw appError;

      // Provider answered but the payload was not usable JSON: quality road.
      if (appError.code === "AI_RESPONSE_INVALID" || kind === "malformed_output") {
        state.previousFailures = [
          {
            stage: 1,
            rule: "schema.provider_output_unparsable",
            message: "Kết quả AI không phải JSON đúng định dạng yêu cầu.",
          },
        ];
        state.lastValidation = {
          pass: false,
          failures: state.previousFailures,
          firstFailedStage: 1,
        };
        return { kind: "quality_failed" };
      }

      // Infra road: one provider swap inside this tier, then give up.
      if (shouldFallback(kind) && !fallbackUsedInTier) {
        const next = selectFallbackModel(policy, tier, usedModelKeys);
        if (next) {
          fallbackUsedInTier = true;
          state.fallbackUsedAnywhere = true;
          attemptLog.warn("Switching provider after infrastructure failure", {
            error_code: appError.code,
            failure_kind: kind ?? null,
            fallback_provider: next.provider,
            fallback_model: next.model,
          });
          entry = next;
          continue;
        }
      }
      throw appError;
    }

    const costUsd = estimateCostUsd(entry, response.usage);
    state.totalCostUsd = Number((state.totalCostUsd + costUsd).toFixed(6));
    state.totalLatencyMs += response.latencyMs;

    const validation = validateGeneratedContent(response.output, input.validationContext);

    await recordAttempt(deps, attemptLog, {
      ...baseLogEntry,
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
      cachedTokens: response.usage.cachedTokens,
      latencyMs: response.latencyMs,
      estimatedCostUsd: costUsd,
      success: true,
      validationPassed: validation.pass,
      validationFailures: validation.failures.map((item) => ({
        stage: item.stage,
        rule: item.rule,
        message: item.message,
      })),
      output: validation.content,
    });

    state.trail.push({
      attemptNo,
      provider: entry.provider,
      model: entry.model,
      tier,
      fallbackUsed: fallbackUsedInTier,
      escalationFrom: state.escalationFrom,
      success: true,
      validationPassed: validation.pass,
      estimatedCostUsd: costUsd,
      latencyMs: response.latencyMs,
    });

    if (validation.pass && validation.content) {
      attemptLog.info("AI generation passed validation", {
        cost_usd: state.totalCostUsd,
        latency_ms: state.totalLatencyMs,
        escalations: state.escalations,
        fallback_used: state.fallbackUsedAnywhere,
      });

      return {
        kind: "passed",
        result: {
          generationId,
          content: validation.content,
          metadata: {
            task: request.task,
            provider: entry.provider,
            model: entry.model,
            tier,
            attempts: state.attemptNo,
            escalations: state.escalations,
            fallbackUsed: state.fallbackUsedAnywhere,
            totalCostUsd: state.totalCostUsd,
            totalLatencyMs: state.totalLatencyMs,
            promptTemplateId: template.id,
            promptVersion: template.version,
            inputHash,
            attemptTrail: state.trail,
          },
        },
      };
    }

    attemptLog.warn("AI output failed validation", {
      error_code: "CAPTION_VALIDATION_FAILED",
      first_failed_stage: validation.firstFailedStage ?? null,
      failures: validation.failures.map((item) => ({ stage: item.stage, rule: item.rule })),
    });

    state.previousFailures = validation.failures;
    state.lastValidation = validation;
    return { kind: "quality_failed" };
  }
}

function buildMessage(userPrompt: string, request: ContentGenerationRequest): NormalizedMessage {
  const parts: NormalizedPart[] = [{ type: "text", text: userPrompt }];

  // MVP sends exactly one image, the cover (docs/ai/architecture.md §4).
  if (request.vision.mode === "single") {
    parts.push({
      type: "image",
      mimeType: request.vision.image.mimeType,
      dataBase64: request.vision.image.dataBase64,
    });
  } else if (request.vision.mode === "multi" && request.vision.images.length > 0) {
    const cover = request.vision.images[0];
    parts.push({ type: "image", mimeType: cover.mimeType, dataBase64: cover.dataBase64 });
  }

  return { role: "user", parts };
}

/**
 * Every attempt writes one `ai_generation` row (prompt-versioning.md §2).
 * A logging outage must not kill a generation that otherwise succeeded, so the
 * failure is logged with full context and the run continues — never silenced.
 */
async function recordAttempt(
  deps: ContentEngineDeps,
  log: Logger,
  entry: GenerationLogEntry,
): Promise<void> {
  try {
    await deps.generationLog.record(entry);
  } catch (error) {
    log.error("Failed to persist ai_generation row", {
      error_code: "INTERNAL",
      generation_id: entry.generationId,
      attempt_no: entry.attemptNo,
      err: error,
    });
  }
}

/** Cost helper for callers that aggregate spend per post (docs/ai/cost-model.md §1). */
export { estimateCostUsd };
