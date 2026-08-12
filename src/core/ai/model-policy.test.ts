import { describe, expect, it } from "vitest";

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
import { makeTestPolicy, TEST_MODELS } from "@/core/ai/testing";
import { AppError } from "@/core/domain/errors";

describe("tierLadder", () => {
  it("caps the ladder at maxEscalations", () => {
    const policy = makeTestPolicy({
      policy: {
        task: "facebook_content",
        vision: "single",
        primary: "cheap",
        escalate: ["mid", "top"],
        maxEscalations: 1,
        maxOutputTokens: 900,
        timeoutMs: 1000,
      },
    });
    expect(tierLadder(policy)).toEqual(["cheap", "mid"]);
  });

  it("is primary-only when escalation is disabled", () => {
    const policy = makeTestPolicy({
      policy: {
        task: "caption_dedupe_check",
        vision: "none",
        primary: "cheap",
        escalate: [],
        maxEscalations: 0,
        maxOutputTokens: 300,
        timeoutMs: 1000,
      },
    });
    expect(tierLadder(policy)).toEqual(["cheap"]);
  });
});

describe("selectPrimaryModel", () => {
  it("throws MODEL_NOT_CONFIGURED when the tier is empty", () => {
    const policy = makeTestPolicy({ tiers: { cheap: [], mid: [], top: [] } });
    try {
      selectPrimaryModel(policy, "cheap");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(AppError.is(error)).toBe(true);
      expect((error as AppError).code).toBe("MODEL_NOT_CONFIGURED");
    }
  });

  it("returns the first model of the tier", () => {
    expect(selectPrimaryModel(makeTestPolicy(), "cheap")).toEqual(TEST_MODELS.cheapGoogle);
  });
});

describe("selectFallbackModel (infra road — same tier, other provider)", () => {
  const policy = makeTestPolicy();

  it("returns the next entry from a DIFFERENT provider", () => {
    expect(selectFallbackModel(policy, "cheap", ["google:cheap"])).toEqual(TEST_MODELS.cheapOpenAI);
  });

  it("returns null when the tier has a single provider", () => {
    expect(selectFallbackModel(policy, "mid", ["google:mid"])).toBeNull();
  });

  it("never returns a provider that already failed", () => {
    expect(selectFallbackModel(policy, "cheap", ["google:cheap", "openai:cheap"])).toBeNull();
  });
});

describe("failure classification (ADR-001 §8)", () => {
  it("routes infra failures to fallback", () => {
    expect(shouldFallback("timeout")).toBe(true);
    expect(shouldFallback("rate_limited")).toBe(true);
    expect(shouldFallback("provider_down")).toBe(true);
    expect(shouldFallback("content_refused")).toBe(true);
  });

  it("never falls back on our own bad request or on quality problems", () => {
    expect(shouldFallback("bad_request")).toBe(false);
    expect(shouldFallback("malformed_output")).toBe(false);
    expect(shouldFallback(undefined)).toBe(false);
    expect(isTerminalFailure("bad_request")).toBe(true);
    expect(isTerminalFailure("timeout")).toBe(false);
  });

  it("reads the kind from the AppError context, not from the message", () => {
    const error = new AppError("AI_RATE_LIMITED", { context: { failure_kind: "rate_limited" } });
    expect(failureKindOf(error)).toBe("rate_limited");
    expect(failureKindOf(new Error("timeout timeout timeout"))).toBeUndefined();
  });
});

describe("cost", () => {
  it("bills cached tokens separately and never twice", () => {
    const entry = {
      ...TEST_MODELS.cheapOpenAI,
      pricing: { inputPerMTokUsd: 1, outputPerMTokUsd: 10, cachedInputPerMTokUsd: 0.1 },
    };
    // 900k billable input * $1 + 100k cached * $0.1 + 1M output * $10
    expect(
      estimateCostUsd(entry, { inputTokens: 1_000_000, outputTokens: 1_000_000, cachedTokens: 100_000 }),
    ).toBeCloseTo(0.9 + 0.01 + 10, 6);
  });

  it("returns 0 for an empty usage report", () => {
    expect(
      estimateCostUsd(TEST_MODELS.cheapGoogle, { inputTokens: 0, outputTokens: 0, cachedTokens: 0 }),
    ).toBe(0);
  });

  it("projects a pre-call ceiling that includes the vision allowance", () => {
    const withImage = projectAttemptCostUsd(TEST_MODELS.cheapGoogle, {
      promptChars: 4000,
      hasImage: true,
      maxOutputTokens: 900,
    });
    const withoutImage = projectAttemptCostUsd(TEST_MODELS.cheapGoogle, {
      promptChars: 4000,
      hasImage: false,
      maxOutputTokens: 900,
    });
    expect(withImage).toBeGreaterThan(withoutImage);
  });
});
