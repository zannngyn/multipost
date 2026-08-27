import { describe, expect, it } from "vitest";

import {
  applyPolicyOverride,
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
import { testTenantId } from "@/core/domain/tenant-context.testing";

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

describe("applyPolicyOverride (ADR-001 — YAML + per-tenant DB override)", () => {
  const TENANT = { tenantId: testTenantId("11111111-1111-1111-1111-111111111111") };

  it("refuses a model key the YAML registry does not declare", () => {
    try {
      applyPolicyOverride(
        makeTestPolicy(),
        { tierModels: { cheap: ["google:model-nobody-reviewed"] } },
        TENANT,
      );
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(AppError.is(error)).toBe(true);
      expect((error as AppError).code).toBe("MODEL_NOT_CONFIGURED");
      expect((error as AppError).context.model_key).toBe("google:model-nobody-reviewed");
    }
  });

  it("refuses an override that empties a tier", () => {
    expect(() =>
      applyPolicyOverride(makeTestPolicy(), { tierModels: { cheap: [] } }, TENANT),
    ).toThrowError(AppError);
  });

  it("refuses an override whose primary tier has no model", () => {
    const policy = makeTestPolicy({
      tiers: { cheap: [TEST_MODELS.cheapGoogle], mid: [], top: [] },
    });
    expect(() => applyPolicyOverride(policy, { primary: "mid" }, TENANT)).toThrowError(AppError);
  });

  it("re-orders providers inside a tier without touching the rest", () => {
    const merged = applyPolicyOverride(
      makeTestPolicy(),
      { tierModels: { cheap: ["openai:cheap", "google:cheap"] } },
      TENANT,
    );
    expect(selectPrimaryModel(merged, "cheap").provider).toBe("openai");
    expect(merged.policy.maxOutputTokens).toBe(900);
    expect(merged.tiers.mid).toEqual(makeTestPolicy().tiers.mid);
  });

  it("overrides routing knobs and the budget, leaving the rest at YAML values", () => {
    const merged = applyPolicyOverride(
      makeTestPolicy(),
      {
        primary: "mid",
        escalate: ["top"],
        maxEscalations: 1,
        budget: { maxCostPerGenerationUsd: 0.2 },
      },
      TENANT,
    );
    expect(tierLadder(merged)).toEqual(["mid", "top"]);
    expect(merged.budget.maxCostPerGenerationUsd).toBe(0.2);
    expect(merged.budget.dailyCostPerTenantUsd).toBe(5);
  });

  it("returns the base policy untouched for an empty override", () => {
    const base = makeTestPolicy();
    expect(applyPolicyOverride(base, {}, TENANT)).toBe(base);
  });
});
