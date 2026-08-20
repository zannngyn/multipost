import { describe, expect, it, vi } from "vitest";

import { makeFakeLogger } from "@/core/ai/testing";
import { AppError } from "@/core/domain/errors";
import type { ContentEngine, ContentGenerationRequest } from "@/core/ports/content-engine";
import { makeGenerateCaptions, type GenerateCaptionsInput } from "@/core/usecases/generate-captions";
import { testTenantId } from "@/core/domain/tenant-context.testing";

const product = {
  name: "Penny",
  description: "Đầm dáng suông tay lỡ. Chất liệu lụa mềm mát, thoải mái cả ngày hè.",
  category: "Đầm",
  season: "Hè 2026",
};

const content = {
  title: "MANG CẢ NHỊP THỞ MÙA HÈ",
  body: "Dáng suông nhẹ nhàng cùng chất liệu lụa mềm mát.",
  hashtags: ["#dam", "#hemoi", "#thoitrangnu"],
  claims: [],
  confidence: 0.9,
};

function makeInput(overrides: Partial<GenerateCaptionsInput> = {}): GenerateCaptionsInput {
  return {
    tenantId: testTenantId("tenant-1"),
    product,
    channels: [
      { channelId: "page-A", platform: "facebook", contentType: "photo_post" },
      { channelId: "page-B", platform: "facebook", contentType: "photo_post" },
    ],
    vision: {
      mode: "single",
      image: { ref: "drive-1", mimeType: "image/jpeg", dataBase64: "AAAA", kind: "real" },
    },
    postJobId: "job-1",
    ...overrides,
  };
}

function stubEngine(
  impl: (request: ContentGenerationRequest) => Promise<unknown>,
): ContentEngine & { requests: ContentGenerationRequest[] } {
  const requests: ContentGenerationRequest[] = [];
  return {
    requests,
    generate: vi.fn(async (request: ContentGenerationRequest) => {
      requests.push(request);
      return (await impl(request)) as never;
    }),
  } as ContentEngine & { requests: ContentGenerationRequest[] };
}

function okResult(id: string) {
  return {
    generationId: id,
    content,
    metadata: {
      task: "facebook_content" as const,
      provider: "google" as const,
      model: "gemini-test",
      tier: "cheap" as const,
      attempts: 1,
      escalations: 0,
      fallbackUsed: false,
      totalCostUsd: 0.003,
      totalLatencyMs: 800,
      promptTemplateId: "facebook-product-content",
      promptVersion: 1,
      inputHash: "abcd1234",
      attemptTrail: [],
    },
  };
}

// ---------------------------------------------------------------------------
// Edge cases first
// ---------------------------------------------------------------------------

describe("generateCaptions — invalid input", () => {
  const deps = { contentEngine: stubEngine(async () => okResult("gen-1")), logger: makeFakeLogger() };

  it("rejects a missing tenantId", async () => {
    await expect(
      makeGenerateCaptions(deps)(makeInput({ tenantId: testTenantId(" ") })),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("rejects an empty channel list", async () => {
    await expect(makeGenerateCaptions(deps)(makeInput({ channels: [] }))).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  });

  it("rejects a duplicated channel id", async () => {
    await expect(
      makeGenerateCaptions(deps)(
        makeInput({
          channels: [
            { channelId: "page-A", platform: "facebook", contentType: "photo_post" },
            { channelId: "page-A", platform: "facebook", contentType: "photo_post" },
          ],
        }),
      ),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("rejects product data missing a whitelisted field", async () => {
    await expect(
      makeGenerateCaptions(deps)(makeInput({ product: { name: "Penny", category: "Đầm" } })),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("rejects a tone outside the closed list instead of writing in the default voice", async () => {
    await expect(
      makeGenerateCaptions(deps)(makeInput({ tone: "giọng nào cũng được" })),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});

// ---------------------------------------------------------------------------
// Tone
// ---------------------------------------------------------------------------

describe("generateCaptions — tone", () => {
  it("passes the chosen tone to the engine for every channel", async () => {
    const engine = stubEngine(async () => okResult("gen-1"));

    await makeGenerateCaptions({ contentEngine: engine, logger: makeFakeLogger() })(
      makeInput({ tone: "sale-manh" }),
    );

    expect(engine.requests).toHaveLength(2);
    for (const request of engine.requests) expect(request.tone).toBe("sale-manh");
  });

  it("falls back to the default tone key when none is given", async () => {
    const engine = stubEngine(async () => okResult("gen-1"));

    await makeGenerateCaptions({ contentEngine: engine, logger: makeFakeLogger() })(makeInput());

    expect(engine.requests[0]?.tone).toBe("mac-dinh");
  });
});

// ---------------------------------------------------------------------------
// Failure propagation
// ---------------------------------------------------------------------------

describe("generateCaptions — failures", () => {
  it("throws CAPTION_VALIDATION_FAILED with per-channel reasons when nothing passes", async () => {
    const engine = stubEngine(async () => {
      throw new AppError("CAPTION_VALIDATION_FAILED", {
        context: { failures: [{ stage: 4, rule: "policy.price_like_number" }] },
      });
    });
    const logger = makeFakeLogger();

    try {
      await makeGenerateCaptions({ contentEngine: engine, logger })(makeInput());
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(AppError.is(error)).toBe(true);
      const appError = error as AppError;
      expect(appError.code).toBe("CAPTION_VALIDATION_FAILED");
      const channels = appError.context.channels as Array<{ channel: string; reason: string }>;
      expect(channels).toHaveLength(2);
      expect(channels[0].channel).toBe("page-A");
      expect(JSON.stringify(channels)).toContain("policy.price_like_number");
    }
    expect(logger.entries.some((entry) => entry.context.error_code === "CAPTION_VALIDATION_FAILED")).toBe(
      true,
    );
  });

  it("keeps the real code when the failure is infrastructural", async () => {
    const engine = stubEngine(async () => {
      throw new AppError("AI_RATE_LIMITED", { context: { failure_kind: "rate_limited" } });
    });
    await expect(
      makeGenerateCaptions({ contentEngine: engine, logger: makeFakeLogger() })(makeInput()),
    ).rejects.toMatchObject({ code: "AI_RATE_LIMITED" });
  });

  it("returns a partial result when one channel fails and another succeeds", async () => {
    let call = 0;
    const engine = stubEngine(async () => {
      call += 1;
      if (call === 1) return okResult("gen-1");
      throw new AppError("AI_PROVIDER_ERROR", { context: { failure_kind: "provider_down" } });
    });
    const logger = makeFakeLogger();

    const result = await makeGenerateCaptions({ contentEngine: engine, logger })(makeInput());

    expect(result.generated).toHaveLength(1);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]).toMatchObject({ channelId: "page-B", code: "AI_PROVIDER_ERROR" });
    // A failed channel is never silent.
    expect(
      logger.entries.some(
        (entry) => entry.context.error_code === "AI_PROVIDER_ERROR" && entry.context.channel === "page-B",
      ),
    ).toBe(true);
  });

  it("reports a platform without a configured task instead of guessing a model", async () => {
    const engine = stubEngine(async () => okResult("gen-1"));
    const result = await makeGenerateCaptions({ contentEngine: engine, logger: makeFakeLogger() })(
      makeInput({
        channels: [
          { channelId: "page-A", platform: "facebook", contentType: "photo_post" },
          { channelId: "tiktok-1", platform: "tiktok", contentType: "reel" },
        ],
      }),
    );

    expect(result.failed[0]).toMatchObject({
      channelId: "tiktok-1",
      code: "MODEL_NOT_CONFIGURED",
    });
    expect(engine.requests).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("generateCaptions — happy path", () => {
  it("builds one caption per channel with the sheet name on the first line", async () => {
    let call = 0;
    const engine = stubEngine(async () => {
      call += 1;
      return okResult(`gen-${call}`);
    });

    const result = await makeGenerateCaptions({ contentEngine: engine, logger: makeFakeLogger() })(
      makeInput(),
    );

    expect(result.generated).toHaveLength(2);
    expect(result.failed).toHaveLength(0);
    expect(result.generated[0].caption.text.startsWith("Penny – MANG CẢ NHỊP THỞ MÙA HÈ")).toBe(true);
    expect(result.totalCostUsd).toBeCloseTo(0.006, 6);
    expect(result.generated[1].generationId).toBe("gen-2");
  });

  it("passes the previous channel's caption on so the D1 check has a reference", async () => {
    const engine = stubEngine(async () => okResult("gen-x"));
    await makeGenerateCaptions({ contentEngine: engine, logger: makeFakeLogger() })(makeInput());

    expect(engine.requests[0].existingCaptions).toEqual([]);
    expect(engine.requests[1].existingCaptions).toHaveLength(1);
    expect(engine.requests[1].existingCaptions?.[0]).toContain("Penny – MANG CẢ NHỊP THỞ MÙA HÈ");
  });

  it("never forwards a non-whitelisted field to the engine", async () => {
    const engine = stubEngine(async () => okResult("gen-1"));
    await makeGenerateCaptions({ contentEngine: engine, logger: makeFakeLogger() })(
      makeInput({ product: { ...product, price: 1_250_000, stock: 0, note: "HẾT HÀNG" } }),
    );

    expect(Object.keys(engine.requests[0].product).sort()).toEqual([
      "category",
      "description",
      "name",
      "season",
    ]);
  });

  it("passes the task chosen from the platform, never a model string", async () => {
    const engine = stubEngine(async () => okResult("gen-1"));
    await makeGenerateCaptions({ contentEngine: engine, logger: makeFakeLogger() })(makeInput());

    expect(engine.requests[0].task).toBe("facebook_content");
    expect(JSON.stringify(engine.requests[0])).not.toContain("gemini");
  });
});
