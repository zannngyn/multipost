/**
 * Test doubles for the AI vertical. Pure and framework-free (no vitest import)
 * so they stay importable from core, adapters and usecase tests alike.
 * Nothing here reaches production wiring — composition never imports this file.
 */

import { AppError } from "@/core/domain/errors";
import type {
  AIFailureKind,
  AIProviderAdapter,
  AIProviderName,
  AITask,
  GenerationLog,
  GenerationLogEntry,
  IdGenerator,
  ModelEntry,
  ModelPolicyStore,
  NormalizedAIRequest,
  NormalizedAIResponse,
  PromptStore,
  PromptTemplate,
  ResolvedModelPolicy,
} from "@/core/ports/ai";
import type { Clock, LogBindings, LogContext, Logger } from "@/core/ports/infra";

// ---------------------------------------------------------------------------
// Infra doubles
// ---------------------------------------------------------------------------

export interface CapturedLog {
  level: "debug" | "info" | "warn" | "error";
  message: string;
  context: Record<string, unknown>;
}

export interface FakeLogger extends Logger {
  entries: CapturedLog[];
}

export function makeFakeLogger(bindings: LogBindings = {}, sink: CapturedLog[] = []): FakeLogger {
  const write = (level: CapturedLog["level"]) => (message: string, context?: LogContext) => {
    sink.push({ level, message, context: { ...bindings, ...context } });
  };
  return {
    entries: sink,
    child: (extra: LogBindings) => makeFakeLogger({ ...bindings, ...extra }, sink),
    debug: write("debug"),
    info: write("info"),
    warn: write("warn"),
    error: write("error"),
  };
}

export function makeFixedClock(iso = "2026-08-13T02:00:00.000Z"): Clock {
  const date = new Date(iso);
  return { now: () => date, nowMs: () => date.getTime() };
}

export function makeSequentialIds(prefix = "gen"): IdGenerator {
  let counter = 0;
  return {
    newId: () => {
      counter += 1;
      return `${prefix}-${counter}`;
    },
  };
}

// ---------------------------------------------------------------------------
// Provider double
// ---------------------------------------------------------------------------

export type ScriptedStep =
  | { kind: "ok"; output: unknown; usage?: { inputTokens: number; outputTokens: number; cachedTokens: number }; latencyMs?: number }
  | { kind: "fail"; code: "AI_PROVIDER_ERROR" | "AI_RATE_LIMITED" | "AI_RESPONSE_INVALID"; failureKind: AIFailureKind };

export interface ScriptedProvider extends AIProviderAdapter {
  calls: NormalizedAIRequest[];
}

/**
 * Replays `steps` one per call; the last step repeats once exhausted so a test
 * can say "this provider is always down" without counting attempts.
 */
export function makeScriptedProvider(
  provider: AIProviderName,
  steps: readonly ScriptedStep[],
): ScriptedProvider {
  const calls: NormalizedAIRequest[] = [];

  return {
    provider,
    calls,
    capabilities: () => ({ vision: true, structuredOutput: true, maxOutputTokens: 8192, temperature: true }),
    async complete(request: NormalizedAIRequest): Promise<NormalizedAIResponse> {
      calls.push(request);
      const step = steps[Math.min(calls.length - 1, steps.length - 1)];
      if (!step) {
        throw new AppError("AI_PROVIDER_ERROR", {
          message: "Scripted provider has no step configured",
          context: { provider, failure_kind: "provider_down" satisfies AIFailureKind },
        });
      }

      if (step.kind === "fail") {
        throw new AppError(step.code, {
          message: `Scripted ${provider} failure: ${step.failureKind}`,
          context: { provider, model: request.model, failure_kind: step.failureKind },
        });
      }

      return {
        output: step.output,
        usage: step.usage ?? { inputTokens: 1200, outputTokens: 400, cachedTokens: 0 },
        latencyMs: step.latencyMs ?? 900,
        raw: { finishReason: "STOP" },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Registry / prompt / log doubles
// ---------------------------------------------------------------------------

export const TEST_MODELS: Record<string, ModelEntry> = {
  cheapGoogle: {
    key: "google:cheap",
    provider: "google",
    model: "gemini-test-flash-lite",
    pricing: { inputPerMTokUsd: 0.3, outputPerMTokUsd: 2.5 },
    capabilities: { vision: true, structuredOutput: true, maxOutputTokens: 8192, temperature: true },
  },
  cheapOpenAI: {
    key: "openai:cheap",
    provider: "openai",
    model: "gpt-test-mini",
    pricing: { inputPerMTokUsd: 0.25, outputPerMTokUsd: 2 },
    capabilities: { vision: true, structuredOutput: true, maxOutputTokens: 8192, temperature: true },
  },
  midGoogle: {
    key: "google:mid",
    provider: "google",
    model: "gemini-test-flash",
    pricing: { inputPerMTokUsd: 1.5, outputPerMTokUsd: 7.5 },
    capabilities: { vision: true, structuredOutput: true, maxOutputTokens: 8192, temperature: true },
  },
  topGoogle: {
    key: "google:top",
    provider: "google",
    model: "gemini-test-pro",
    pricing: { inputPerMTokUsd: 2, outputPerMTokUsd: 12 },
    capabilities: { vision: true, structuredOutput: true, maxOutputTokens: 8192, temperature: true },
  },
};

export function makeTestPolicy(overrides: Partial<ResolvedModelPolicy> = {}): ResolvedModelPolicy {
  const task: AITask = overrides.task ?? "facebook_content";
  return {
    task,
    policy: {
      task,
      vision: "single",
      primary: "cheap",
      escalate: ["mid", "top"],
      maxEscalations: 2,
      maxOutputTokens: 900,
      timeoutMs: 30_000,
      temperature: 0.8,
      ...overrides.policy,
    },
    tiers: overrides.tiers ?? {
      cheap: [TEST_MODELS.cheapGoogle, TEST_MODELS.cheapOpenAI],
      mid: [TEST_MODELS.midGoogle],
      top: [TEST_MODELS.topGoogle],
    },
    budget: overrides.budget ?? { maxCostPerGenerationUsd: 0.05, dailyCostPerTenantUsd: 5 },
    registryVersion: overrides.registryVersion ?? 1,
  };
}

export function makeStubPolicyStore(policy: ResolvedModelPolicy): ModelPolicyStore {
  return { async getPolicy() { return policy; } };
}

export const TEST_PROMPT_TEMPLATE: PromptTemplate = {
  id: "test-facebook-content",
  task: "facebook_content",
  platform: "facebook",
  tenantId: null,
  version: 3,
  status: "active",
  systemPrompt: "SYSTEM: viết content bán hàng.",
  userPromptTemplate:
    "Tên: {{product.name}}\nMô tả: {{product.description}}\nRàng buộc:\n{{constraints}}\n{{previousFailures}}",
  changelog: "test fixture",
};

export function makeStubPromptStore(template: PromptTemplate | null = TEST_PROMPT_TEMPLATE): PromptStore {
  return { async getActive() { return template; } };
}

export interface RecordingGenerationLog extends GenerationLog {
  entries: GenerationLogEntry[];
}

export function makeRecordingGenerationLog(): RecordingGenerationLog {
  const entries: GenerationLogEntry[] = [];
  return {
    entries,
    async record(entry) {
      entries.push(entry);
    },
  };
}
