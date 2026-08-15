/**
 * Gateway wiring test: REAL registry file + REAL prompt template + real
 * validation pipeline, with scripted providers in place of the SDKs.
 * Catches the class of bug unit tests miss — a mismatch between the YAML we
 * ship, the prompt we ship and the engine that consumes them.
 */

import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { makeLoggerGenerationLog } from "@/adapters/ai/generation-log/logger-generation-log";
import { makeStaticPromptStore } from "@/adapters/ai/prompt-store/static-prompt-store";
import { makeYamlModelPolicyStore } from "@/adapters/ai/registry-store/yaml-model-policy-store";
import { makeContentEngine } from "@/core/ai/content-engine";
import {
  makeFakeLogger,
  makeFixedClock,
  makeScriptedProvider,
  makeSequentialIds,
} from "@/core/ai/testing";
import { buildCaptionText } from "@/core/domain/caption";
import { AppError } from "@/core/domain/errors";
import type { ContentGenerationRequest } from "@/core/ports/content-engine";

const REGISTRY = join(process.cwd(), "config", "ai-models.yaml");

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
  confidence: 0.83,
};

const secondChannelOutput = {
  title: "NẮNG LÊN, DỊU DÀNG BƯỚC RA PHỐ",
  body: "Từng đường cắt tinh tế ôm nhẹ dáng người, nút ngọc điểm xuyết cho ngày thênh thang.",
  hashtags: ["#penny", "#damcongso", "#hedeu"],
  claims: [{ field: "other", statement: "nút ngọc điểm xuyết", sourceText: "phối nút ngọc tinh tế" }],
  confidence: 0.79,
};

/**
 * Single-provider stack (owner decision 15/08/2026): the shipped registry lists
 * OpenAI models only. Google is still WIRED here on purpose — the tests must
 * show the engine never wanders to a provider the registry did not name.
 */
function makeStack(steps: Parameters<typeof makeScriptedProvider>[1]) {
  const logger = makeFakeLogger();
  const openai = makeScriptedProvider("openai", steps);
  const google = makeScriptedProvider("google", [{ kind: "ok", output: goodOutput }]);

  const engine = makeContentEngine({
    providers: { google, openai },
    policies: makeYamlModelPolicyStore({ filePath: REGISTRY, clock: makeFixedClock(), logger }),
    prompts: makeStaticPromptStore(),
    generationLog: makeLoggerGenerationLog(logger),
    logger,
    clock: makeFixedClock(),
    ids: makeSequentialIds(),
  });

  return { engine, google, openai, logger };
}

const baseRequest: ContentGenerationRequest = {
  tenantId: "tenant-1",
  task: "facebook_content",
  product,
  platform: "facebook",
  contentType: "photo_post",
  vision: {
    mode: "single",
    image: { ref: "drive-1", mimeType: "image/jpeg", dataBase64: "QUJD", kind: "real" },
  },
  language: "vi",
  constraints: { hashtagMin: 3, hashtagMax: 5 },
  channelId: "page-A",
};

describe("AI gateway — real registry + real prompt", () => {
  it("routes facebook_content to the cheap OpenAI model and passes validation", async () => {
    const { engine, openai } = makeStack([{ kind: "ok", output: goodOutput }]);

    const result = await engine.generate(baseRequest);

    expect(result.metadata.provider).toBe("openai");
    expect(result.metadata.tier).toBe("cheap");
    expect(result.metadata.model).toBe("gpt-5-mini");
    expect(result.metadata.promptTemplateId).toBe("facebook-product-content");

    const prompt = openai.calls[0].messages[0].parts[0];
    expect(prompt.type === "text" && prompt.text).toContain("Penny");
    expect(openai.calls[0].maxOutputTokens).toBe(900);
    expect(openai.calls[0].timeoutMs).toBe(30_000);
  });

  it("fails the generation on an infra error instead of swapping to an unlisted provider", async () => {
    // Single provider = no infra fallback road. Google is wired but absent from
    // every tier, so the engine must surface the outage, not quietly use it.
    const { engine, google } = makeStack([
      { kind: "fail", code: "AI_RATE_LIMITED", failureKind: "rate_limited" },
    ]);

    await expect(engine.generate(baseRequest)).rejects.toMatchObject({
      code: "AI_RATE_LIMITED",
    });
    expect(google.calls).toHaveLength(0);
  });

  it("escalates cheap -> mid when validation fails, using registry tiers", async () => {
    const { engine, openai } = makeStack([
      { kind: "ok", output: { ...goodOutput, body: "Đầm lụa mềm mát, chỉ 1.250.000 thôi nàng ơi." } },
      { kind: "ok", output: goodOutput },
    ]);

    const result = await engine.generate(baseRequest);

    expect(result.metadata.tier).toBe("mid");
    expect(result.metadata.model).toBe("gpt-5.4-mini");
    expect(openai.calls).toHaveLength(2);
  });

  it("accepts a second channel whose caption differs from the first // PENDING(D1)", async () => {
    const { engine } = makeStack([
      { kind: "ok", output: goodOutput },
      { kind: "ok", output: secondChannelOutput },
    ]);

    const first = await engine.generate(baseRequest);
    const firstCaption = buildCaptionText(product.name, first.content);

    const second = await engine.generate({
      ...baseRequest,
      channelId: "page-B",
      existingCaptions: [firstCaption],
    });

    expect(firstCaption).toContain("Penny – MANG CẢ NHỊP THỞ");
    expect(buildCaptionText(product.name, second.content)).toContain("Penny – NẮNG LÊN");
    const totalCost = first.metadata.totalCostUsd + second.metadata.totalCostUsd;
    expect(totalCost).toBeGreaterThan(0);
    // Two channels, cheap tier, one attempt each: far under the per-generation ceiling.
    expect(totalCost).toBeLessThan(0.05);
  });

  it("blocks the whole post when every tier keeps writing a price", async () => {
    const { engine, openai } = makeStack([
      { kind: "ok", output: { ...goodOutput, body: "Chỉ 750.000 cho mùa hè này." } },
    ]);

    await expect(engine.generate(baseRequest)).rejects.toMatchObject({
      code: "CAPTION_VALIDATION_FAILED",
    });
    // cheap -> mid -> top, exactly maxEscalations = 2 from the YAML. `top` reuses
    // the mid model while openai:gpt-5 waits for verified pricing — the third
    // attempt is a fresh try carrying the validator feedback, not a bigger model.
    expect(openai.calls.map((call) => call.model)).toEqual([
      "gpt-5-mini",
      "gpt-5.4-mini",
      "gpt-5.4-mini",
    ]);
  });

  it("stops with AI_BUDGET_EXCEEDED instead of escalating past the ceiling", async () => {
    // A single runaway attempt already spends more than the $0.05 per-generation
    // ceiling, so the escalation to `mid` must never leave.
    const { engine, openai } = makeStack([
      {
        kind: "ok",
        output: { ...goodOutput, body: "Chỉ 750.000 thôi." },
        usage: { inputTokens: 900_000, outputTokens: 900, cachedTokens: 0 },
      },
      { kind: "ok", output: goodOutput },
    ]);

    try {
      await engine.generate(baseRequest);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(AppError.is(error)).toBe(true);
      expect((error as AppError).code).toBe("AI_BUDGET_EXCEEDED");
    }
    expect(openai.calls).toHaveLength(1);
  });
});
