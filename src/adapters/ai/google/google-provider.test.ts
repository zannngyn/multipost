/**
 * Google adapter tests. HTTP is mocked at `globalThis.fetch`, so the real SDK
 * code path runs but no request ever leaves the machine and no API key is used.
 * Live calls belong to the E4.9 benchmark, on the PAID tier, run on purpose.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { makeGoogleProviderAdapter } from "@/adapters/ai/google/google-provider";
import { GENERATED_CONTENT_JSON_SCHEMA } from "@/core/ai/generated-content";
import { makeFakeLogger } from "@/core/ai/testing";
import { AppError } from "@/core/domain/errors";
import type { NormalizedAIRequest } from "@/core/ports/ai";

const request: NormalizedAIRequest = {
  model: "gemini-test-flash-lite",
  system: "SYSTEM",
  messages: [
    {
      role: "user",
      parts: [
        { type: "text", text: "Viết caption cho Penny" },
        { type: "image", mimeType: "image/jpeg", dataBase64: "QUJD" },
      ],
    },
  ],
  outputSchema: GENERATED_CONTENT_JSON_SCHEMA,
  maxOutputTokens: 900,
  timeoutMs: 5_000,
  temperature: 0.8,
  metadata: { generationId: "gen-1", task: "facebook_content", tenantId: "tenant-1" },
};

const content = {
  title: "MÙA HÈ RỰC RỠ",
  body: "Dáng suông nhẹ nhàng.",
  hashtags: ["#a", "#b", "#c"],
  claims: [],
  confidence: 0.7,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function stubFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const spy = vi.fn(async (input: unknown, init: RequestInit = {}) =>
    handler(String(input), init ?? {}),
  );
  vi.stubGlobal("fetch", spy);
  return spy;
}

function makeAdapter() {
  return makeGoogleProviderAdapter({
    apiKey: "test-key",
    logger: makeFakeLogger(),
    baseUrl: "https://generativelanguage.test",
    now: (() => {
      let t = 1_000;
      return () => (t += 250);
    })(),
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Edge cases first
// ---------------------------------------------------------------------------

describe("Google adapter — wiring", () => {
  it("refuses to build without an API key", () => {
    expect(() => makeGoogleProviderAdapter({ apiKey: "", logger: makeFakeLogger() })).toThrowError(
      AppError,
    );
  });
});

describe("Google adapter — error mapping", () => {
  it("maps 429 to AI_RATE_LIMITED with failure_kind", async () => {
    stubFetch(() => jsonResponse({ error: { message: "quota" } }, 429));

    try {
      await makeAdapter().complete(request);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(AppError.is(error)).toBe(true);
      const appError = error as AppError;
      expect(appError.code).toBe("AI_RATE_LIMITED");
      expect(appError.context).toMatchObject({
        provider: "google",
        model: "gemini-test-flash-lite",
        status: 429,
        failure_kind: "rate_limited",
        tenant_id: "tenant-1",
      });
    }
  });

  it("maps 503 to AI_PROVIDER_ERROR / provider_down", async () => {
    stubFetch(() => jsonResponse({ error: { message: "unavailable" } }, 503));
    await expect(makeAdapter().complete(request)).rejects.toMatchObject({
      code: "AI_PROVIDER_ERROR",
      context: { failure_kind: "provider_down", status: 503 },
    });
  });

  it("maps 400 to bad_request so the gateway stops instead of retrying", async () => {
    stubFetch(() => jsonResponse({ error: { message: "bad schema" } }, 400));
    await expect(makeAdapter().complete(request)).rejects.toMatchObject({
      code: "AI_PROVIDER_ERROR",
      context: { failure_kind: "bad_request", status: 400 },
    });
  });

  it("maps a network abort to a timeout", async () => {
    stubFetch(() => {
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    });
    await expect(makeAdapter().complete(request)).rejects.toMatchObject({
      context: { failure_kind: "timeout" },
    });
  });

  it("maps a safety block to content_refused", async () => {
    stubFetch(() =>
      jsonResponse({
        candidates: [{ content: { parts: [{ text: "{}" }] }, finishReason: "SAFETY" }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 0 },
      }),
    );
    await expect(makeAdapter().complete(request)).rejects.toMatchObject({
      code: "AI_PROVIDER_ERROR",
      context: { failure_kind: "content_refused" },
    });
  });

  it("maps a non-JSON payload to AI_RESPONSE_INVALID without echoing it", async () => {
    stubFetch(() =>
      jsonResponse({
        candidates: [{ content: { parts: [{ text: "Xin chào, đây không phải JSON" }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
      }),
    );

    try {
      await makeAdapter().complete(request);
      expect.unreachable("should have thrown");
    } catch (error) {
      const appError = error as AppError;
      expect(appError.code).toBe("AI_RESPONSE_INVALID");
      expect(appError.context.failure_kind).toBe("malformed_output");
      expect(JSON.stringify(appError.context)).not.toContain("Xin chào");
    }
  });

  it("names truncation at maxOutputTokens instead of blaming the payload", async () => {
    // Thinking models bill reasoning against maxOutputTokens, so the budget can
    // run out before any JSON is emitted: a real risk with a 900-token cap.
    stubFetch(() =>
      jsonResponse({
        candidates: [{ content: { parts: [] }, finishReason: "MAX_TOKENS" }],
        usageMetadata: { promptTokenCount: 1500, candidatesTokenCount: 900, thoughtsTokenCount: 880 },
      }),
    );

    try {
      await makeAdapter().complete(request);
      expect.unreachable("should have thrown");
    } catch (error) {
      const appError = error as AppError;
      expect(appError.code).toBe("AI_RESPONSE_INVALID");
      // Same routing as any malformed output — only the diagnosis is richer.
      expect(appError.context).toMatchObject({
        failure_kind: "malformed_output",
        truncated: true,
        finish_reason: "MAX_TOKENS",
        max_output_tokens: 900,
        thoughts_tokens: 880,
      });
      expect(appError.message).toContain("maxOutputTokens");
    }
  });

  it("maps an empty candidate list to malformed_output", async () => {
    stubFetch(() => jsonResponse({ candidates: [], usageMetadata: {} }));
    await expect(makeAdapter().complete(request)).rejects.toMatchObject({
      code: "AI_RESPONSE_INVALID",
    });
  });
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("Google adapter — successful call", () => {
  it("sends structured output + exactly one inline image, and normalises usage", async () => {
    const fetchSpy = stubFetch(() =>
      jsonResponse({
        candidates: [
          { content: { parts: [{ text: JSON.stringify(content) }] }, finishReason: "STOP" },
        ],
        usageMetadata: {
          promptTokenCount: 1500,
          candidatesTokenCount: 320,
          cachedContentTokenCount: 100,
        },
      }),
    );

    const response = await makeAdapter().complete(request);

    expect(response.output).toEqual(content);
    expect(response.usage).toEqual({ inputTokens: 1500, outputTokens: 320, cachedTokens: 100 });
    expect(response.latencyMs).toBeGreaterThan(0);
    expect(response.raw?.finishReason).toBe("STOP");

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("generativelanguage.test");
    expect(url).toContain("gemini-test-flash-lite");

    const body = JSON.parse(String(init.body));
    expect(body.generationConfig?.responseMimeType ?? body.generationConfig?.response_mime_type).toBe(
      "application/json",
    );
    expect(JSON.stringify(body)).toContain("hashtags");
    const parts = body.contents[0].parts as Array<Record<string, unknown>>;
    expect(parts.filter((part) => "inlineData" in part || "inline_data" in part)).toHaveLength(1);
    expect(JSON.stringify(body.systemInstruction ?? body.system_instruction)).toContain("SYSTEM");
  });
});
