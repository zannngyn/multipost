/**
 * OpenAI adapter — INFRASTRUCTURE FALLBACK only (ADR-001 §8, provider-strategy.md §3).
 * It runs when Google times out, rate-limits or is down; it is never chosen for
 * quality reasons, and it never picks its own model.
 *
 * `maxRetries: 0` is deliberate: the gateway owns retry/fallback, so SDK-level
 * retries would silently multiply cost and hide provider flakiness.
 */

import OpenAI, { APIError } from "openai";

import { AppError } from "@/core/domain/errors";
import type {
  AIProviderAdapter,
  ModelCapabilities,
  NormalizedAIRequest,
  NormalizedAIResponse,
  NormalizedMessage,
} from "@/core/ports/ai";
import type { Logger } from "@/core/ports/infra";
import { GENERATED_CONTENT_SCHEMA_NAME } from "@/core/ai/generated-content";
import {
  failureKindFromStatus,
  isAbortLike,
  toProviderError,
  type ProviderErrorContext,
} from "@/adapters/ai/failure-mapping";

export interface OpenAIProviderOptions {
  apiKey: string;
  logger: Logger;
  baseUrl?: string;
  now?: () => number;
}

export function makeOpenAIProviderAdapter(options: OpenAIProviderOptions): AIProviderAdapter {
  if (!options.apiKey || options.apiKey.trim().length === 0) {
    throw new AppError("MODEL_NOT_CONFIGURED", {
      message: "OpenAI adapter requires an API key",
      userMessage: "Chưa cấu hình khoá API OpenAI cho nhà cung cấp dự phòng.",
      context: { provider: "openai" },
    });
  }

  const client = new OpenAI({
    apiKey: options.apiKey,
    baseURL: options.baseUrl,
    maxRetries: 0,
  });
  const now = options.now ?? Date.now;

  return {
    provider: "openai",

    capabilities(_model: string): ModelCapabilities {
      return { vision: true, structuredOutput: true, maxOutputTokens: 8192 };
    },

    async complete(request: NormalizedAIRequest): Promise<NormalizedAIResponse> {
      const errorContext: ProviderErrorContext = {
        provider: "openai",
        model: request.model,
        generationId: request.metadata.generationId,
        tenantId: request.metadata.tenantId,
        task: request.metadata.task,
      };
      const startedAt = now();

      let response;
      try {
        response = await client.responses.create(
          {
            model: request.model,
            instructions: request.system,
            input: request.messages.map(toOpenAIMessage),
            max_output_tokens: request.maxOutputTokens,
            temperature: request.temperature,
            text: {
              format: {
                type: "json_schema",
                name: GENERATED_CONTENT_SCHEMA_NAME,
                // Strict mode rejects the array cardinality keywords, so they are
                // dropped here and enforced by validation stage 1 instead.
                schema: stripUnsupportedStrictKeywords(request.outputSchema),
                strict: true,
              },
            },
          },
          { timeout: request.timeoutMs, maxRetries: 0 },
        );
      } catch (error) {
        const status = error instanceof APIError ? error.status : undefined;
        const kind = isAbortLike(error) ? "timeout" : failureKindFromStatus(status);

        options.logger.warn("OpenAI call failed", {
          provider: "openai",
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
          `OpenAI responses.create failed (${kind})`,
          { ...errorContext, status },
          error,
        );
      }

      const latencyMs = now() - startedAt;

      const refusal = findRefusal(response);
      if (refusal) {
        throw toProviderError("content_refused", `OpenAI refused the content: ${refusal}`, errorContext);
      }

      const text = response.output_text;
      if (typeof text !== "string" || text.trim().length === 0) {
        // Same trap as Gemini: reasoning models spend the output budget before
        // the JSON starts, and the API reports it as status "incomplete" with
        // reason "max_output_tokens". Naming it here saves an escalation ladder
        // spent chasing a phantom quality problem.
        const incompleteReason = response.incomplete_details?.reason;
        const truncated = incompleteReason === "max_output_tokens";
        if (truncated) {
          options.logger.warn("OpenAI output truncated at max_output_tokens", {
            provider: "openai",
            model: request.model,
            tenant_id: request.metadata.tenantId,
            generation_id: request.metadata.generationId,
            task: request.metadata.task,
            failure_kind: "malformed_output",
            max_output_tokens: request.maxOutputTokens,
            output_tokens: response.usage?.output_tokens ?? 0,
            reasoning_tokens: response.usage?.output_tokens_details?.reasoning_tokens ?? 0,
          });
        }

        throw toProviderError(
          "malformed_output",
          truncated
            ? `OpenAI hit max_output_tokens (${request.maxOutputTokens}) before emitting JSON`
            : `OpenAI returned no output text (status=${response.status ?? "unknown"})`,
          {
            ...errorContext,
            details: {
              response_status: response.status ?? null,
              truncated,
              ...(truncated
                ? {
                    max_output_tokens: request.maxOutputTokens,
                    reasoning_tokens: response.usage?.output_tokens_details?.reasoning_tokens ?? 0,
                  }
                : {}),
            },
          },
        );
      }

      let output: unknown;
      try {
        output = JSON.parse(text);
      } catch (error) {
        throw toProviderError(
          "malformed_output",
          "OpenAI returned a non-JSON payload despite structured output",
          errorContext,
          error,
        );
      }

      return {
        output,
        usage: {
          inputTokens: response.usage?.input_tokens ?? 0,
          outputTokens: response.usage?.output_tokens ?? 0,
          cachedTokens: response.usage?.input_tokens_details?.cached_tokens ?? 0,
        },
        latencyMs,
        raw: { finishReason: response.status ?? undefined },
      };
    },
  };
}

function toOpenAIMessage(message: NormalizedMessage) {
  return {
    role: message.role,
    content: message.parts.map((part) =>
      part.type === "text"
        ? ({ type: "input_text", text: part.text } as const)
        : ({
            type: "input_image",
            image_url: `data:${part.mimeType};base64,${part.dataBase64}`,
            detail: "auto",
          } as const),
    ),
  };
}

function findRefusal(response: { output?: unknown }): string | null {
  const output = response.output;
  if (!Array.isArray(output)) return null;

  for (const item of output) {
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      const typed = part as { type?: string; refusal?: string };
      if (typed.type === "refusal" && typed.refusal) return typed.refusal;
    }
  }
  return null;
}

/** OpenAI strict structured outputs reject these validation keywords. */
const UNSUPPORTED_STRICT_KEYWORDS = ["minItems", "maxItems", "minimum", "maximum"] as const;

export function stripUnsupportedStrictKeywords(schema: unknown): Record<string, unknown> {
  return strip(schema) as Record<string, unknown>;
}

function strip(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strip);
  if (typeof node !== "object" || node === null) return node;

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if ((UNSUPPORTED_STRICT_KEYWORDS as readonly string[]).includes(key)) continue;
    result[key] = strip(value);
  }
  return result;
}
