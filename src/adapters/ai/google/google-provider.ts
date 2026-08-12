/**
 * Google AI Studio (Gemini) adapter — PRIMARY provider on every tier
 * (ADR-001 owner decision 12/08/2026).
 *
 * ⚠️ PAID TIER IS MANDATORY anywhere real shop data flows: the AI Studio free
 * tier grants Google the right to train on what we send, and product copy plus
 * photos are the shop's assets (docs/ai/provider-strategy.md §3). Free tier is
 * for local experiments with fake data only.
 *
 * Adapter rules (provider-strategy.md §1): structured output is mandatory, no
 * retries here (the gateway owns retry/fallback), no knowledge of task policy,
 * every SDK error becomes an AppError carrying `failure_kind`.
 */

import { ApiError, GoogleGenAI } from "@google/genai";

import { AppError } from "@/core/domain/errors";
import type {
  AIProviderAdapter,
  ModelCapabilities,
  NormalizedAIRequest,
  NormalizedAIResponse,
  NormalizedPart,
} from "@/core/ports/ai";
import type { Logger } from "@/core/ports/infra";
import {
  failureKindFromStatus,
  isAbortLike,
  toProviderError,
  type ProviderErrorContext,
} from "@/adapters/ai/failure-mapping";

export interface GoogleProviderOptions {
  apiKey: string;
  logger: Logger;
  /** Override the API endpoint (tests point this at a stub server). */
  baseUrl?: string;
  /** Injectable clock so latency assertions are deterministic in tests. */
  now?: () => number;
}

/** Finish reasons that mean "the model refused", not "the call broke". */
const REFUSAL_FINISH_REASONS = new Set(["SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII"]);

export function makeGoogleProviderAdapter(options: GoogleProviderOptions): AIProviderAdapter {
  // Guard: a missing key must fail at wiring time, not on the first generation.
  if (!options.apiKey || options.apiKey.trim().length === 0) {
    throw new AppError("MODEL_NOT_CONFIGURED", {
      message: "Google AI adapter requires an API key (paid tier)",
      userMessage: "Chưa cấu hình khoá API Google AI (bắt buộc dùng gói trả phí).",
      context: { provider: "google" },
    });
  }

  const client = new GoogleGenAI({
    apiKey: options.apiKey,
    httpOptions: options.baseUrl ? { baseUrl: options.baseUrl } : undefined,
  });
  const now = options.now ?? Date.now;

  return {
    provider: "google",

    capabilities(_model: string): ModelCapabilities {
      // Every Gemini model in the registry supports both; the registry holds the
      // authoritative per-model numbers.
      return { vision: true, structuredOutput: true, maxOutputTokens: 8192 };
    },

    async complete(request: NormalizedAIRequest): Promise<NormalizedAIResponse> {
      const errorContext: ProviderErrorContext = {
        provider: "google",
        model: request.model,
        generationId: request.metadata.generationId,
        tenantId: request.metadata.tenantId,
        task: request.metadata.task,
      };
      const startedAt = now();

      let response;
      try {
        response = await client.models.generateContent({
          model: request.model,
          contents: request.messages.map((message) => ({
            role: message.role,
            parts: message.parts.map(toGooglePart),
          })),
          config: {
            systemInstruction: request.system,
            // Structured output — mandatory for generation tasks (ADR-001 #4).
            responseMimeType: "application/json",
            responseJsonSchema: request.outputSchema,
            maxOutputTokens: request.maxOutputTokens,
            temperature: request.temperature,
            abortSignal: AbortSignal.timeout(request.timeoutMs),
            httpOptions: { timeout: request.timeoutMs },
          },
        });
      } catch (error) {
        const kind =
          error instanceof ApiError
            ? failureKindFromStatus(error.status)
            : isAbortLike(error)
              ? "timeout"
              : "provider_down";
        const status = error instanceof ApiError ? error.status : undefined;

        options.logger.warn("Google AI call failed", {
          provider: "google",
          model: request.model,
          tenant_id: request.metadata.tenantId,
          generation_id: request.metadata.generationId,
          task: request.metadata.task,
          failure_kind: kind,
          status,
          err: error,
        });

        throw toProviderError(
          kind,
          `Google AI generateContent failed (${kind})`,
          { ...errorContext, status },
          error,
        );
      }

      const latencyMs = now() - startedAt;
      const candidate = response.candidates?.[0];
      const finishReason = candidate?.finishReason ? String(candidate.finishReason) : undefined;
      const blockReason = response.promptFeedback?.blockReason;

      if (blockReason || (finishReason && REFUSAL_FINISH_REASONS.has(finishReason))) {
        throw toProviderError(
          "content_refused",
          `Google AI refused the content (${blockReason ?? finishReason})`,
          errorContext,
        );
      }

      const text = response.text;
      if (typeof text !== "string" || text.trim().length === 0) {
        throw toProviderError(
          "malformed_output",
          `Google AI returned no text part (finishReason=${finishReason ?? "unknown"})`,
          errorContext,
        );
      }

      let output: unknown;
      try {
        output = JSON.parse(text);
      } catch (error) {
        // Never log or attach the raw text: it can be arbitrarily long and is
        // kept in ai_generation instead.
        throw toProviderError(
          "malformed_output",
          "Google AI returned a non-JSON payload despite structured output",
          errorContext,
          error,
        );
      }

      const usage = response.usageMetadata;
      return {
        output,
        usage: {
          inputTokens: usage?.promptTokenCount ?? 0,
          outputTokens: usage?.candidatesTokenCount ?? 0,
          cachedTokens: usage?.cachedContentTokenCount ?? 0,
        },
        latencyMs,
        raw: { finishReason },
      };
    },
  };
}

function toGooglePart(part: NormalizedPart) {
  if (part.type === "text") return { text: part.text };
  // Vision: exactly one cover image per generation (docs/ai/architecture.md §4);
  // the caller already resized it (cost-model.md §4.2).
  return { inlineData: { mimeType: part.mimeType, data: part.dataBase64 } };
}
