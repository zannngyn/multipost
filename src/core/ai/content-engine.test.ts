import { describe, expect, it } from "vitest";

import { makeContentEngine, type ContentEngineDeps } from "@/core/ai/content-engine";
import {
  makeFakeLogger,
  makeFixedClock,
  makeRecordingGenerationLog,
  makeScriptedProvider,
  makeSequentialIds,
  makeStubPolicyStore,
  makeStubPromptStore,
  makeTestPolicy,
  TEST_PROMPT_TEMPLATE,
  type ScriptedProvider,
  type ScriptedStep,
} from "@/core/ai/testing";
import { AppError } from "@/core/domain/errors";
import type { ResolvedModelPolicy } from "@/core/ports/ai";
import type { ContentGenerationRequest } from "@/core/ports/content-engine";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const product = {
  name: "Penny",
  description:
    "Đầm dáng suông tay lỡ, phối nút ngọc tinh tế. Chất liệu lụa mềm mát, thấm hút tốt, thoải mái cả ngày hè.",
  category: "Đầm",
  season: "Hè 2026",
};

const goodOutput = {
  title: "MANG CẢ NHỊP THỞ MÙA HÈ VÀO TỪNG BƯỚC CHÂN",
  body: "Dáng suông nhẹ nhàng, tay lỡ thanh lịch cùng chất liệu lụa mềm mát nâng niu làn da suốt ngày dài.",
  hashtags: ["#dam", "#hemoi", "#thoitrangnu"],
  claims: [{ field: "material", statement: "chất liệu lụa mềm mát", sourceText: "Chất liệu lụa mềm mát" }],
  confidence: 0.8,
};

const priceyOutput = { ...goodOutput, body: "Đầm lụa mềm mát, chỉ 1.250.000 cho mùa hè này." };

function makeRequest(overrides: Partial<ContentGenerationRequest> = {}): ContentGenerationRequest {
  return {
    tenantId: "tenant-1",
    task: "facebook_content",
    product,
    platform: "facebook",
    contentType: "photo_post",
    vision: {
      mode: "single",
      image: { ref: "drive-1", mimeType: "image/jpeg", dataBase64: "AAAA", kind: "real" },
    },
    language: "vi",
    constraints: { hashtagMin: 3, hashtagMax: 5 },
    channelId: "page-A",
    postJobId: "job-1",
    requestId: "req-1",
    ...overrides,
  };
}

interface Harness {
  deps: ContentEngineDeps;
  google: ScriptedProvider;
  openai: ScriptedProvider;
  logs: ReturnType<typeof makeFakeLogger>;
  generationLog: ReturnType<typeof makeRecordingGenerationLog>;
}

function makeHarness(options: {
  google: readonly ScriptedStep[];
  openai?: readonly ScriptedStep[];
  policy?: ResolvedModelPolicy;
  promptTemplate?: typeof TEST_PROMPT_TEMPLATE | null;
  wireOpenAI?: boolean;
}): Harness {
  const google = makeScriptedProvider("google", options.google);
  const openai = makeScriptedProvider("openai", options.openai ?? [{ kind: "ok", output: goodOutput }]);
  const logs = makeFakeLogger();
  const generationLog = makeRecordingGenerationLog();

  const deps: ContentEngineDeps = {
    providers: options.wireOpenAI === false ? { google } : { google, openai },
    policies: makeStubPolicyStore(options.policy ?? makeTestPolicy()),
    prompts: makeStubPromptStore(
      options.promptTemplate === undefined ? TEST_PROMPT_TEMPLATE : options.promptTemplate,
    ),
    generationLog,
    logger: logs,
    clock: makeFixedClock(),
    ids: makeSequentialIds(),
  };

  return { deps, google, openai, logs, generationLog };
}

async function expectAppError(promise: Promise<unknown>, code: string): Promise<AppError> {
  try {
    await promise;
    expect.unreachable(`should have thrown ${code}`);
  } catch (error) {
    expect(AppError.is(error)).toBe(true);
    expect((error as AppError).code).toBe(code);
    return error as AppError;
  }
  throw new Error("unreachable");
}

// ---------------------------------------------------------------------------
// Edge cases first
// ---------------------------------------------------------------------------

describe("ContentEngine — rejected before any provider call", () => {
  it("rejects a missing tenantId", async () => {
    const { deps, google } = makeHarness({ google: [{ kind: "ok", output: goodOutput }] });
    await expectAppError(
      makeContentEngine(deps).generate(makeRequest({ tenantId: "  " })),
      "INVALID_INPUT",
    );
    expect(google.calls).toHaveLength(0);
  });

  it("rejects product data that fails the whitelist schema", async () => {
    const { deps, google } = makeHarness({ google: [{ kind: "ok", output: goodOutput }] });
    await expectAppError(
      makeContentEngine(deps).generate(
        makeRequest({ product: { name: "", description: "x", category: "y", season: "z" } }),
      ),
      "INVALID_INPUT",
    );
    expect(google.calls).toHaveLength(0);
  });

  it("raises PROMPT_NOT_FOUND when no active template exists", async () => {
    const { deps, google } = makeHarness({
      google: [{ kind: "ok", output: goodOutput }],
      promptTemplate: null,
    });
    await expectAppError(makeContentEngine(deps).generate(makeRequest()), "PROMPT_NOT_FOUND");
    expect(google.calls).toHaveLength(0);
  });

  it("raises MODEL_NOT_CONFIGURED when the registry names an unwired provider", async () => {
    const policy = makeTestPolicy({
      tiers: {
        cheap: [
          {
            key: "anthropic:cheap",
            provider: "anthropic",
            model: "claude-test",
            pricing: { inputPerMTokUsd: 1, outputPerMTokUsd: 5 },
            capabilities: { vision: true, structuredOutput: true, maxOutputTokens: 4096 },
          },
        ],
        mid: [],
        top: [],
      },
    });
    const { deps } = makeHarness({ google: [{ kind: "ok", output: goodOutput }], policy });
    await expectAppError(makeContentEngine(deps).generate(makeRequest()), "MODEL_NOT_CONFIGURED");
  });

  it("raises AI_BUDGET_EXCEEDED before spending when the ceiling is already too low", async () => {
    const policy = makeTestPolicy({ budget: { maxCostPerGenerationUsd: 0.0000001, dailyCostPerTenantUsd: 1 } });
    const { deps, google } = makeHarness({ google: [{ kind: "ok", output: goodOutput }], policy });
    await expectAppError(makeContentEngine(deps).generate(makeRequest()), "AI_BUDGET_EXCEEDED");
    expect(google.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Infra road — fallback
// ---------------------------------------------------------------------------

describe("ContentEngine — provider fallback (infra failures)", () => {
  it("switches to the other provider of the SAME tier on a rate limit", async () => {
    const { deps, google, openai, generationLog } = makeHarness({
      google: [{ kind: "fail", code: "AI_RATE_LIMITED", failureKind: "rate_limited" }],
      openai: [{ kind: "ok", output: goodOutput }],
    });

    const result = await makeContentEngine(deps).generate(makeRequest());

    expect(google.calls).toHaveLength(1);
    expect(openai.calls).toHaveLength(1);
    expect(result.metadata.provider).toBe("openai");
    expect(result.metadata.tier).toBe("cheap");
    expect(result.metadata.fallbackUsed).toBe(true);
    expect(result.metadata.escalations).toBe(0);
    // Both attempts are logged, the failed one included (prompt-versioning.md §2).
    expect(generationLog.entries).toHaveLength(2);
    expect(generationLog.entries[0]).toMatchObject({ success: false, failureKind: "rate_limited" });
    expect(generationLog.entries[1]).toMatchObject({ success: true, fallbackUsed: true });
  });

  it("falls back on a timeout as well", async () => {
    const { deps, openai } = makeHarness({
      google: [{ kind: "fail", code: "AI_PROVIDER_ERROR", failureKind: "timeout" }],
      openai: [{ kind: "ok", output: goodOutput }],
    });
    const result = await makeContentEngine(deps).generate(makeRequest());
    expect(openai.calls).toHaveLength(1);
    expect(result.metadata.fallbackUsed).toBe(true);
  });

  it("surfaces AI_PROVIDER_ERROR when both providers of the tier are down", async () => {
    const { deps, google, openai } = makeHarness({
      google: [{ kind: "fail", code: "AI_PROVIDER_ERROR", failureKind: "provider_down" }],
      openai: [{ kind: "fail", code: "AI_PROVIDER_ERROR", failureKind: "provider_down" }],
    });

    const error = await expectAppError(
      makeContentEngine(deps).generate(makeRequest()),
      "AI_PROVIDER_ERROR",
    );
    expect(google.calls).toHaveLength(1);
    expect(openai.calls).toHaveLength(1);
    expect(error.context.provider).toBe("openai");
  });

  it("keeps AI_RATE_LIMITED when both providers are rate limited", async () => {
    const { deps } = makeHarness({
      google: [{ kind: "fail", code: "AI_RATE_LIMITED", failureKind: "rate_limited" }],
      openai: [{ kind: "fail", code: "AI_RATE_LIMITED", failureKind: "rate_limited" }],
    });
    await expectAppError(makeContentEngine(deps).generate(makeRequest()), "AI_RATE_LIMITED");
  });

  it("does not fall back or escalate on AI_BAD_REQUEST (our own bug)", async () => {
    const { deps, google, openai } = makeHarness({
      google: [{ kind: "fail", code: "AI_PROVIDER_ERROR", failureKind: "bad_request" }],
      openai: [{ kind: "ok", output: goodOutput }],
    });

    const error = await expectAppError(
      makeContentEngine(deps).generate(makeRequest()),
      "AI_PROVIDER_ERROR",
    );
    expect(error.context.failure_kind).toBe("bad_request");
    expect(google.calls).toHaveLength(1);
    expect(openai.calls).toHaveLength(0);
  });

  it("only falls back once per tier, then stops", async () => {
    const { deps, google, openai } = makeHarness({
      google: [{ kind: "fail", code: "AI_PROVIDER_ERROR", failureKind: "provider_down" }],
      openai: [{ kind: "fail", code: "AI_PROVIDER_ERROR", failureKind: "timeout" }],
    });
    await expectAppError(makeContentEngine(deps).generate(makeRequest()), "AI_PROVIDER_ERROR");
    expect(google.calls.length + openai.calls.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Quality road — escalation
// ---------------------------------------------------------------------------

describe("ContentEngine — quality escalation", () => {
  it("escalates to the next tier and feeds the failure reasons into the prompt", async () => {
    const { deps, google } = makeHarness({
      google: [
        { kind: "ok", output: priceyOutput },
        { kind: "ok", output: goodOutput },
      ],
    });

    const result = await makeContentEngine(deps).generate(makeRequest());

    expect(google.calls).toHaveLength(2);
    expect(result.metadata.tier).toBe("mid");
    expect(result.metadata.escalations).toBe(1);
    expect(result.metadata.fallbackUsed).toBe(false);
    // The retry prompt must say WHY the previous attempt was rejected.
    const retryPrompt = google.calls[1].messages[0].parts[0];
    expect(retryPrompt.type === "text" && retryPrompt.text).toContain("policy.price_like_number");
  });

  it("fails with CAPTION_VALIDATION_FAILED after every tier when a price keeps appearing", async () => {
    const { deps, google, generationLog } = makeHarness({
      google: [{ kind: "ok", output: priceyOutput }],
    });

    const error = await expectAppError(
      makeContentEngine(deps).generate(makeRequest()),
      "CAPTION_VALIDATION_FAILED",
    );

    // cheap -> mid -> top, one attempt each (maxEscalations = 2).
    expect(google.calls).toHaveLength(3);
    expect(generationLog.entries).toHaveLength(3);
    expect(generationLog.entries.map((entry) => entry.tier)).toEqual(["cheap", "mid", "top"]);
    expect(JSON.stringify(error.context.failures)).toContain("policy.price_like_number");
  });

  it("fails with CAPTION_VALIDATION_FAILED when the caption duplicates another channel // PENDING(D1)", async () => {
    const { deps } = makeHarness({ google: [{ kind: "ok", output: goodOutput }] });
    const previous =
      "Penny – MÙA HÈ RỰC RỠ\n\nDáng suông nhẹ nhàng, tay lỡ thanh lịch cùng chất liệu lụa mềm mát nâng niu làn da suốt ngày dài.\n\n#a #b #c";

    const error = await expectAppError(
      makeContentEngine(deps).generate(makeRequest({ existingCaptions: [previous] })),
      "CAPTION_VALIDATION_FAILED",
    );
    expect(JSON.stringify(error.context.failures)).toContain("duplicate_with_other_channel");
  });

  it("fails with AI_RESPONSE_INVALID — and never leaks the raw output — on a broken schema", async () => {
    const rawGarbage = { title: 42, secret: "CHIẾN DỊCH NỘI BỘ 1.250.000" };
    const { deps, google } = makeHarness({ google: [{ kind: "ok", output: rawGarbage }] });

    const error = await expectAppError(
      makeContentEngine(deps).generate(makeRequest()),
      "AI_RESPONSE_INVALID",
    );

    expect(google.calls).toHaveLength(3);
    const serialised = JSON.stringify(error.context);
    expect(serialised).not.toContain("CHIẾN DỊCH NỘI BỘ");
    expect(serialised).not.toContain("1.250.000");
  });

  it("treats an unparsable provider payload as a quality failure, not a fallback", async () => {
    const { deps, google, openai } = makeHarness({
      google: [{ kind: "fail", code: "AI_RESPONSE_INVALID", failureKind: "malformed_output" }],
      openai: [{ kind: "ok", output: goodOutput }],
    });

    await expectAppError(makeContentEngine(deps).generate(makeRequest()), "AI_RESPONSE_INVALID");
    // 3 tiers x google only: the infra fallback road was never taken.
    expect(google.calls).toHaveLength(3);
    expect(openai.calls).toHaveLength(0);
  });

  it("stops escalating when the budget ceiling would be crossed", async () => {
    const policy = makeTestPolicy({ budget: { maxCostPerGenerationUsd: 0.004, dailyCostPerTenantUsd: 1 } });
    const { deps, google } = makeHarness({ google: [{ kind: "ok", output: priceyOutput }], policy });

    await expectAppError(makeContentEngine(deps).generate(makeRequest()), "AI_BUDGET_EXCEEDED");
    expect(google.calls.length).toBeGreaterThanOrEqual(1);
    expect(google.calls.length).toBeLessThan(3);
  });
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("ContentEngine — happy path", () => {
  it("returns validated content with full generation metadata", async () => {
    const { deps, generationLog, logs } = makeHarness({
      google: [{ kind: "ok", output: goodOutput }],
    });

    const result = await makeContentEngine(deps).generate(makeRequest());

    expect(result.content.title).toBe(goodOutput.title);
    expect(result.metadata).toMatchObject({
      task: "facebook_content",
      provider: "google",
      tier: "cheap",
      attempts: 1,
      escalations: 0,
      fallbackUsed: false,
      promptTemplateId: TEST_PROMPT_TEMPLATE.id,
      promptVersion: TEST_PROMPT_TEMPLATE.version,
    });
    expect(result.metadata.totalCostUsd).toBeGreaterThan(0);

    const logged = generationLog.entries[0];
    expect(logged).toMatchObject({
      tenantId: "tenant-1",
      task: "facebook_content",
      provider: "google",
      tier: "cheap",
      attemptNo: 1,
      success: true,
      validationPassed: true,
      channelId: "page-A",
      postJobId: "job-1",
    });
    expect(logged.estimatedCostUsd).toBeGreaterThan(0);
    expect(logged.inputHash).toMatch(/^[0-9a-f]{8}$/);

    // Structured logs must answer "why/where" without a debugger.
    const passLine = logs.entries.find((entry) => entry.message.includes("passed validation"));
    expect(passLine?.context).toMatchObject({
      tenant_id: "tenant-1",
      task: "facebook_content",
      provider: "google",
      model: "gemini-test-flash-lite",
      tier: "cheap",
    });
  });

  it("sends exactly one image and never sends a forbidden column", async () => {
    const { deps, google } = makeHarness({ google: [{ kind: "ok", output: goodOutput }] });

    await makeContentEngine(deps).generate(
      makeRequest({
        // A caller smuggling price/stock in must not be able to leak them.
        product: { ...product, price: 1_250_000, stock: 7, note: "HẾT HÀNG" } as never,
      }),
    );

    const parts = google.calls[0].messages[0].parts;
    expect(parts.filter((part) => part.type === "image")).toHaveLength(1);
    const promptText = parts
      .filter((part) => part.type === "text")
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("\n");
    expect(promptText).not.toContain("1250000");
    expect(promptText).not.toContain("HẾT HÀNG");
    expect(promptText).toContain("Penny");
  });

  it("keeps generating even when the generation log is unavailable", async () => {
    const { deps } = makeHarness({ google: [{ kind: "ok", output: goodOutput }] });
    const brokenLog = {
      async record() {
        throw new Error("db down");
      },
    };

    const result = await makeContentEngine({ ...deps, generationLog: brokenLog }).generate(
      makeRequest(),
    );
    expect(result.content.title).toBe(goodOutput.title);
  });
});
