/**
 * AI ports — core declares what the AI gateway needs; adapters implement it.
 * Pure TypeScript, no SDK, no I/O (docs/07 §2, ADR-001).
 *
 * Contract source: docs/ai/provider-strategy.md §1 (adapter), model-routing.md §2
 * (registry), prompt-versioning.md §1–2 (template + generation log).
 */

import type { ClaimField } from "@/core/domain/caption";
import type { TenantId } from "@/core/domain/tenant-context";

// ---------------------------------------------------------------------------
// Routing vocabulary
// ---------------------------------------------------------------------------

/** Routing unit (docs/ai/model-routing.md §2). Business code passes a task, never a model. */
export const AI_TASKS = [
  "facebook_content",
  "product_understanding",
  "caption_dedupe_check",
  "difficult_content",
] as const;
export type AITask = (typeof AI_TASKS)[number];

export const AI_TIERS = ["cheap", "mid", "top"] as const;
export type AITier = (typeof AI_TIERS)[number];

export const AI_PROVIDERS = ["google", "openai", "anthropic"] as const;
export type AIProviderName = (typeof AI_PROVIDERS)[number];

export type VisionMode = "none" | "single" | "multi";

/**
 * Why a provider call failed, at the granularity ADR-001 §8 routes on.
 *
 * NOTE (deviation, documented): ADR names dedicated error codes
 * (`AI_TIMEOUT`/`AI_PROVIDER_DOWN`/`AI_CONTENT_REFUSED`/`AI_BAD_REQUEST`).
 * `core/domain/errors.ts` is frozen for this sprint and ships
 * `AI_PROVIDER_ERROR` + `AI_RATE_LIMITED` only, so the finer reason travels in
 * `AppError.context.failure_kind` and the gateway branches on THIS value —
 * never on an error message.
 */
export const AI_FAILURE_KINDS = [
  "timeout",
  "rate_limited",
  "provider_down",
  "content_refused",
  "bad_request",
  "malformed_output",
] as const;
export type AIFailureKind = (typeof AI_FAILURE_KINDS)[number];

// ---------------------------------------------------------------------------
// AIProviderAdapter — one shape every provider speaks
// ---------------------------------------------------------------------------

export interface NormalizedTextPart {
  type: "text";
  text: string;
}

export interface NormalizedImagePart {
  type: "image";
  mimeType: string;
  /** Base64 payload, already resized by the media layer. */
  dataBase64: string;
}

export type NormalizedPart = NormalizedTextPart | NormalizedImagePart;

export interface NormalizedMessage {
  role: "user";
  parts: NormalizedPart[];
}

/** JSON Schema subset shared by every provider's structured-output mode. */
export type JSONSchema = Readonly<Record<string, unknown>>;

export interface NormalizedAIRequest {
  /** Decided by ModelPolicy — an adapter never picks its own model. */
  model: string;
  system: string;
  messages: NormalizedMessage[];
  /** Structured output is MANDATORY for generation tasks (ADR-001, nguyên tắc #4). */
  outputSchema: JSONSchema;
  maxOutputTokens: number;
  timeoutMs: number;
  temperature?: number;
  metadata: { generationId: string; task: AITask; tenantId: TenantId };
}

export interface AIUsage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
}

export interface NormalizedAIResponse {
  /** Parsed JSON, still untrusted — validation stage 1 owns the schema check. */
  output: unknown;
  usage: AIUsage;
  latencyMs: number;
  /** Debug only. Business code must not read this. */
  raw?: { finishReason?: string };
}

export interface ModelCapabilities {
  vision: boolean;
  structuredOutput: boolean;
  maxOutputTokens: number;
  /**
   * Whether the model accepts a `temperature` at all. The GPT-5 family rejects
   * it outright (HTTP 400 "Unsupported parameter"), so this is a hard capability
   * — not a preference. It lives here, per model, because ADR-001 keeps model
   * knowledge in the registry: an adapter must never branch on a model name.
   */
  temperature: boolean;
}

export interface AIProviderAdapter {
  readonly provider: AIProviderName;
  /** Throws AppError with `context.failure_kind` set. Never retries (gateway owns retry). */
  complete(request: NormalizedAIRequest): Promise<NormalizedAIResponse>;
  /**
   * Diagnostics only — the ROUTING authority is the registry entry
   * (`ModelEntry.capabilities`), which is what the engine reads. An adapter must
   * never branch on a model name, so it can only state a conservative floor for
   * the whole provider here. Nothing in `core/` consults this.
   */
  capabilities(model: string): ModelCapabilities;
}

// ---------------------------------------------------------------------------
// ModelPolicyStore — the registry (docs/ai/model-routing.md §2)
// ---------------------------------------------------------------------------

export interface ModelPricing {
  inputPerMTokUsd: number;
  outputPerMTokUsd: number;
  cachedInputPerMTokUsd?: number;
}

export interface ModelEntry {
  /** Registry key, e.g. "google:gemini-3.5-flash-lite". */
  key: string;
  provider: AIProviderName;
  model: string;
  pricing: ModelPricing;
  capabilities: ModelCapabilities;
}

export interface TaskPolicy {
  task: AITask;
  vision: VisionMode;
  primary: AITier;
  escalate: AITier[];
  maxEscalations: number;
  maxOutputTokens: number;
  timeoutMs: number;
  temperature?: number;
}

export interface AIBudget {
  /** Hard ceiling for ONE generation, escalations included (docs/ai/cost-model.md §3). */
  maxCostPerGenerationUsd: number;
  dailyCostPerTenantUsd: number;
}

export interface ResolvedModelPolicy {
  task: AITask;
  policy: TaskPolicy;
  tiers: Readonly<Record<AITier, readonly ModelEntry[]>>;
  budget: AIBudget;
  /** Registry revision used, for the generation log. */
  registryVersion: number;
}

export interface ModelPolicyStore {
  /** Throws AppError('MODEL_NOT_CONFIGURED') when the task has no usable policy. */
  getPolicy(query: { tenantId: TenantId; task: AITask }): Promise<ResolvedModelPolicy>;
}

/**
 * Per-tenant registry override (ADR-001 §"Registry = YAML + DB override").
 *
 * Deliberately NOT able to introduce a new model string: `tierModels` may only
 * re-order / restrict keys that already exist in `config/ai-models.yaml`. A DB
 * row must never be able to point production at a model nobody reviewed.
 */
export interface ModelPolicyOverride {
  vision?: VisionMode;
  primary?: AITier;
  escalate?: AITier[];
  maxEscalations?: number;
  maxOutputTokens?: number;
  timeoutMs?: number;
  temperature?: number;
  /** Registry keys per tier, in priority order. Position 2+ = infra fallback. */
  tierModels?: Partial<Record<AITier, string[]>>;
  budget?: Partial<AIBudget>;
}

export interface ModelPolicyOverrideRecord {
  tenantId: TenantId;
  task: AITask;
  override: ModelPolicyOverride;
  note: string | null;
  updatedAt: string;
}

export interface ModelPolicyOverrideRepo {
  /** null = this tenant runs the YAML registry unchanged. */
  findOverride(query: {
    tenantId: TenantId;
    task: AITask;
  }): Promise<ModelPolicyOverrideRecord | null>;
}

// ---------------------------------------------------------------------------
// PromptStore — versioned, immutable templates (docs/ai/prompt-versioning.md §1)
// ---------------------------------------------------------------------------

export type PromptStatus = "draft" | "active" | "retired";

export interface PromptTemplate {
  id: string;
  task: AITask;
  platform: string;
  /** null = built-in template shared by every tenant. */
  tenantId: TenantId | null;
  version: number;
  status: PromptStatus;
  systemPrompt: string;
  userPromptTemplate: string;
  changelog: string;
}

export interface PromptStore {
  /** Returns null when no active template exists — caller raises PROMPT_NOT_FOUND. */
  getActive(query: {
    tenantId: TenantId;
    task: AITask;
    platform: string;
  }): Promise<PromptTemplate | null>;
}

/**
 * A stored template row. `PromptTemplate` is what the gateway renders;
 * this adds the bookkeeping the admin screen (E10.7) needs.
 */
export interface PromptTemplateRecord extends PromptTemplate {
  /** Human label of the version, e.g. "Tết 2027 voice". */
  name: string;
  /** Variable names found in the body when it was saved (UI hint + audit). */
  variables: readonly string[];
  createdBy: string | null;
  createdAt: string;
}

export interface PromptTemplateQuery {
  tenantId: TenantId;
  task: AITask;
  platform: string;
}

export interface NewPromptTemplate extends PromptTemplateQuery {
  id: string;
  name: string;
  version: number;
  systemPrompt: string;
  userPromptTemplate: string;
  variables: readonly string[];
  changelog: string;
  createdBy?: string | null;
  /** Activating on create is one transaction: no window with two active rows. */
  activate: boolean;
}

/**
 * Versioned prompt storage (docs/ai/prompt-versioning.md §1). Rows are
 * IMMUTABLE: there is no update method on purpose — editing means a new
 * version, so every past generation still points at the exact text used.
 */
export interface PromptTemplateRepo {
  /** Newest version first. */
  listVersions(query: PromptTemplateQuery): Promise<readonly PromptTemplateRecord[]>;
  getActive(query: PromptTemplateQuery): Promise<PromptTemplateRecord | null>;
  getVersion(query: PromptTemplateQuery & { version: number }): Promise<PromptTemplateRecord | null>;
  /** Highest stored version, 0 when the tenant has none yet. */
  maxVersion(query: PromptTemplateQuery): Promise<number>;
  /** Throws INVALID_INPUT (reason PROMPT_VERSION_TAKEN) on a version collision. */
  create(input: NewPromptTemplate): Promise<PromptTemplateRecord>;
  /** Atomically makes `version` the only active row. null = version not found. */
  activate(
    query: PromptTemplateQuery & { version: number },
  ): Promise<PromptTemplateRecord | null>;
}

// ---------------------------------------------------------------------------
// GenerationLog — one row per attempt (docs/ai/prompt-versioning.md §2)
// ---------------------------------------------------------------------------

export interface ValidationFailureLog {
  stage: 1 | 2 | 3 | 4;
  rule: string;
  message: string;
}

export interface GenerationLogEntry {
  generationId: string;
  attemptNo: number;
  requestId?: string;
  tenantId: TenantId;
  task: AITask;
  postJobId?: string;
  channelId?: string;
  /** Post batch this generation serves; null before the batch exists. */
  batchId?: string;
  /** Product code, for "why did THIS product fail" queries. Never in a prompt. */
  productCode?: string;
  promptTemplateId: string;
  promptVersion: number;
  provider: AIProviderName;
  model: string;
  tier: AITier;
  /** Provider swapped because of an INFRA failure (never because of quality). */
  fallbackUsed: boolean;
  /** Attempt number this one escalated from; null on the first attempt. */
  escalationFrom: number | null;
  inputHash: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  latencyMs: number;
  estimatedCostUsd: number;
  /** The API call itself succeeded (says nothing about validation). */
  success: boolean;
  validationPassed?: boolean;
  validationFailures?: ValidationFailureLog[];
  output?: unknown;
  errorCode?: string;
  failureKind?: AIFailureKind;
  createdAt: string;
}

export interface GenerationLog {
  record(entry: GenerationLogEntry): Promise<void>;
}

// ---------------------------------------------------------------------------
// Misc ports
// ---------------------------------------------------------------------------

/** core never calls `crypto.randomUUID()` itself — ids arrive through this port. */
export interface IdGenerator {
  newId(): string;
}

/** Re-exported so adapters can type claims without reaching into the domain twice. */
export type { ClaimField };
