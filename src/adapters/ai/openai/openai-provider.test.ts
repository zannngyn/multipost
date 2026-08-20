/**
 * OpenAI adapter tests — HTTP mocked at `globalThis.fetch`. No live call, no key.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  makeOpenAIProviderAdapter,
  stripUnsupportedStrictKeywords,
} from "@/adapters/ai/openai/openai-provider";
import { GENERATED_CONTENT_JSON_SCHEMA } from "@/core/ai/generated-content";
import { makeFakeLogger } from "@/core/ai/testing";
import { AppError } from "@/core/domain/errors";
import type { NormalizedAIRequest } from "@/core/ports/ai";
import { testTenantId } from "@/core/domain/tenant-context.testing";

const request: NormalizedAIRequest = {
  model: "gpt-test-mini",
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
  metadata: { generationId: "gen-1", task: "facebook_content", tenantId: testTenantId("tenant-1") },
};

const content = {
  title: "MÙA HÈ RỰC RỠ",
  body: "Dáng suông nhẹ nhàng.",
  hashtags: ["#a", "#b", "#c"],
  claims: [],
  confidence: 0.7,
};

function responseBody(text: string) {
  return {
    id: "resp_1",
    object: "response",
    created_at: 1_700_000_000,
    status: "completed",
    model: "gpt-test-mini",
    output: [
      {
        id: "msg_1",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    ],
    usage: {
      input_tokens: 1500,
      input_tokens_details: { cached_tokens: 200 },
      output_tokens: 320,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 1820,
    },
  };
}

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

/** Body of the single stubbed HTTP call; fails loudly if nothing was sent. */
function requestBodyOf(spy: ReturnType<typeof stubFetch>): BodyInit | null | undefined {
  const call = spy.mock.calls[0];
  expect(call).toBeDefined();
  return call?.[1]?.body;
}

function makeAdapter() {
  return makeOpenAIProviderAdapter({
    apiKey: "test-key",
    logger: makeFakeLogger(),
    baseUrl: "https://api.openai.test/v1",
    now: (() => {
      let t = 1_000;
      return () => (t += 300);
    })(),
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Edge cases first
// ---------------------------------------------------------------------------

describe("OpenAI adapter — wiring", () => {
  it("refuses to build without an API key", () => {
    expect(() => makeOpenAIProviderAdapter({ apiKey: " ", logger: makeFakeLogger() })).toThrowError(
      AppError,
    );
  });

  /**
   * Regression, verified live 15/08/2026: a GPT-5 model answers
   * 400 "Unsupported parameter: 'temperature' is not supported with this model".
   * The engine decides not to send one (registry capability); this pins that an
   * absent temperature really does leave the wire, rather than being serialised
   * as `"temperature": null`.
   */
  it("omits temperature from the request body when the engine sends none", async () => {
    const spy = stubFetch(() => jsonResponse(responseBody(JSON.stringify(content))));

    await makeAdapter().complete(request);

    const body = JSON.parse(String(requestBodyOf(spy)));
    expect(body).not.toHaveProperty("temperature");
    expect(body.max_output_tokens).toBe(900);
  });

  it("sends the temperature when the engine does supply one", async () => {
    const spy = stubFetch(() => jsonResponse(responseBody(JSON.stringify(content))));

    await makeAdapter().complete({ ...request, temperature: 0.8 });

    expect(JSON.parse(String(requestBodyOf(spy))).temperature).toBe(0.8);
  });

  it("strips the keywords strict structured outputs reject", () => {
    const stripped = stripUnsupportedStrictKeywords(GENERATED_CONTENT_JSON_SCHEMA);
    const serialised = JSON.stringify(stripped);
    expect(serialised).not.toContain("minItems");
    expect(serialised).not.toContain("maxItems");
    expect(serialised).not.toContain("minimum");
    expect(serialised).toContain("hashtags");
    expect(serialised).toContain("additionalProperties");
  });
});

describe("OpenAI adapter — error mapping", () => {
  it("maps 429 to AI_RATE_LIMITED", async () => {
    stubFetch(() => jsonResponse({ error: { message: "rate limited" } }, 429));
    await expect(makeAdapter().complete(request)).rejects.toMatchObject({
      code: "AI_RATE_LIMITED",
      context: { provider: "openai", failure_kind: "rate_limited", status: 429 },
    });
  });

  it("maps 500 to provider_down", async () => {
    stubFetch(() => jsonResponse({ error: { message: "boom" } }, 500));
    await expect(makeAdapter().complete(request)).rejects.toMatchObject({
      code: "AI_PROVIDER_ERROR",
      context: { failure_kind: "provider_down" },
    });
  });

  it("maps 400 to bad_request", async () => {
    stubFetch(() => jsonResponse({ error: { message: "invalid schema" } }, 400));
    await expect(makeAdapter().complete(request)).rejects.toMatchObject({
      context: { failure_kind: "bad_request", status: 400 },
    });
  });

  it("maps a refusal part to content_refused", async () => {
    stubFetch(() =>
      jsonResponse({
        ...responseBody(""),
        output: [
          {
            id: "msg_1",
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "refusal", refusal: "I cannot help with that" }],
          },
        ],
      }),
    );
    await expect(makeAdapter().complete(request)).rejects.toMatchObject({
      code: "AI_PROVIDER_ERROR",
      context: { failure_kind: "content_refused" },
    });
  });

  it("names truncation at max_output_tokens instead of blaming the payload", async () => {
    stubFetch(() =>
      jsonResponse({
        ...responseBody(""),
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        usage: {
          input_tokens: 1500,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: 900,
          output_tokens_details: { reasoning_tokens: 900 },
          total_tokens: 2400,
        },
      }),
    );

    try {
      await makeAdapter().complete(request);
      expect.unreachable("should have thrown");
    } catch (error) {
      const appError = error as AppError;
      expect(appError.code).toBe("AI_RESPONSE_INVALID");
      expect(appError.context).toMatchObject({
        failure_kind: "malformed_output",
        truncated: true,
        max_output_tokens: 900,
        reasoning_tokens: 900,
      });
      expect(appError.message).toContain("max_output_tokens");
    }
  });

  it("maps a non-JSON payload to AI_RESPONSE_INVALID without echoing it", async () => {
    stubFetch(() => jsonResponse(responseBody("đây không phải JSON")));

    try {
      await makeAdapter().complete(request);
      expect.unreachable("should have thrown");
    } catch (error) {
      const appError = error as AppError;
      expect(appError.code).toBe("AI_RESPONSE_INVALID");
      expect(JSON.stringify(appError.context)).not.toContain("đây không phải JSON");
    }
  });
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("OpenAI adapter — successful call", () => {
  it("sends strict json_schema, one image, no SDK-level retries", async () => {
    const fetchSpy = stubFetch(() => jsonResponse(responseBody(JSON.stringify(content))));

    const response = await makeAdapter().complete(request);

    expect(response.output).toEqual(content);
    expect(response.usage).toEqual({ inputTokens: 1500, outputTokens: 320, cachedTokens: 200 });
    expect(response.latencyMs).toBeGreaterThan(0);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("api.openai.test/v1/responses");

    const body = JSON.parse(String(init.body));
    expect(body.model).toBe("gpt-test-mini");
    expect(body.instructions).toBe("SYSTEM");
    expect(body.max_output_tokens).toBe(900);
    expect(body.text.format).toMatchObject({ type: "json_schema", strict: true });
    expect(JSON.stringify(body.text.format.schema)).not.toContain("minItems");

    const parts = body.input[0].content as Array<{ type: string; image_url?: string }>;
    expect(parts.filter((part) => part.type === "input_image")).toHaveLength(1);
    expect(parts.find((part) => part.type === "input_image")?.image_url).toBe(
      "data:image/jpeg;base64,QUJD",
    );
  });
});
