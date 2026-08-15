import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parse as parseYaml } from "yaml";

import { afterAll, describe, expect, it } from "vitest";

import { makeYamlModelPolicyStore } from "@/adapters/ai/registry-store/yaml-model-policy-store";
import { makeFakeLogger, makeFixedClock } from "@/core/ai/testing";
import { AppError } from "@/core/domain/errors";

const REAL_REGISTRY = join(process.cwd(), "config", "ai-models.yaml");
const tempDir = mkdtempSync(join(tmpdir(), "mysp-registry-"));

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function writeTemp(name: string, content: string): string {
  const path = join(tempDir, name);
  writeFileSync(path, content, "utf8");
  return path;
}

function makeStore(
  filePath: string,
  tierModels?: Partial<Record<"cheap" | "mid" | "top", string>>,
) {
  return makeYamlModelPolicyStore({
    filePath,
    clock: makeFixedClock(),
    logger: makeFakeLogger(),
    ttlMs: 60_000,
    tierModels,
  });
}

async function expectModelNotConfigured(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
    expect.unreachable("should have thrown MODEL_NOT_CONFIGURED");
  } catch (error) {
    expect(AppError.is(error)).toBe(true);
    expect((error as AppError).code).toBe("MODEL_NOT_CONFIGURED");
    return error as AppError;
  }
  throw new Error("unreachable");
}

// ---------------------------------------------------------------------------
// Edge cases first — a broken registry must fail fast, never half-work
// ---------------------------------------------------------------------------

describe("YAML model policy store — invalid registries", () => {
  it("fails when the file does not exist", async () => {
    const store = makeStore(join(tempDir, "missing.yaml"));
    await expectModelNotConfigured(store.getPolicy({ tenantId: "t1", task: "facebook_content" }));
  });

  it("fails on malformed YAML", async () => {
    const path = writeTemp("broken.yaml", "tiers: [unclosed\n  - x");
    await expectModelNotConfigured(
      makeStore(path).getPolicy({ tenantId: "t1", task: "facebook_content" }),
    );
  });

  it("fails when a required field is missing", async () => {
    const path = writeTemp(
      "no-budget.yaml",
      `version: 1
models:
  "google:a":
    provider: google
    model: a
    pricing: { inputPerMTokUsd: 1, outputPerMTokUsd: 2 }
    capabilities: { vision: true, structuredOutput: true, maxOutputTokens: 100 }
tiers:
  cheap: ["google:a"]
tasks:
  facebook_content:
    vision: single
    primary: cheap
    escalate: []
    maxEscalations: 0
    maxOutputTokens: 900
    timeoutMs: 1000
`,
    );
    const error = await expectModelNotConfigured(
      makeStore(path).getPolicy({ tenantId: "t1", task: "facebook_content" }),
    );
    expect(JSON.stringify(error.context.issues)).toContain("budget");
  });

  it("fails when a tier references an unknown model key", async () => {
    const path = writeTemp(
      "dangling.yaml",
      `version: 1
models:
  "google:a":
    provider: google
    model: a
    pricing: { inputPerMTokUsd: 1, outputPerMTokUsd: 2 }
    capabilities: { vision: true, structuredOutput: true, maxOutputTokens: 100 }
tiers:
  cheap: ["google:a", "openai:ghost"]
tasks:
  facebook_content:
    vision: single
    primary: cheap
    escalate: []
    maxEscalations: 0
    maxOutputTokens: 900
    timeoutMs: 1000
budget:
  maxCostPerGenerationUsd: 0.05
  dailyCostPerTenantUsd: 5
`,
    );
    const error = await expectModelNotConfigured(
      makeStore(path).getPolicy({ tenantId: "t1", task: "facebook_content" }),
    );
    expect(JSON.stringify(error.context.problems)).toContain("openai:ghost");
  });

  it("fails when an unknown provider is used", async () => {
    const path = writeTemp(
      "bad-provider.yaml",
      `version: 1
models:
  "mistral:a":
    provider: mistral
    model: a
    pricing: { inputPerMTokUsd: 1, outputPerMTokUsd: 2 }
    capabilities: { vision: true, structuredOutput: true, maxOutputTokens: 100 }
tiers:
  cheap: ["mistral:a"]
tasks:
  facebook_content:
    vision: single
    primary: cheap
    escalate: []
    maxEscalations: 0
    maxOutputTokens: 900
    timeoutMs: 1000
budget:
  maxCostPerGenerationUsd: 0.05
  dailyCostPerTenantUsd: 5
`,
    );
    await expectModelNotConfigured(
      makeStore(path).getPolicy({ tenantId: "t1", task: "facebook_content" }),
    );
  });

  it("fails when a task promises more escalations than it lists tiers", async () => {
    const path = writeTemp(
      "escalation-mismatch.yaml",
      `version: 1
models:
  "google:a":
    provider: google
    model: a
    pricing: { inputPerMTokUsd: 1, outputPerMTokUsd: 2 }
    capabilities: { vision: true, structuredOutput: true, maxOutputTokens: 100 }
tiers:
  cheap: ["google:a"]
tasks:
  facebook_content:
    vision: single
    primary: cheap
    escalate: []
    maxEscalations: 2
    maxOutputTokens: 900
    timeoutMs: 1000
budget:
  maxCostPerGenerationUsd: 0.05
  dailyCostPerTenantUsd: 5
`,
    );
    await expectModelNotConfigured(
      makeStore(path).getPolicy({ tenantId: "t1", task: "facebook_content" }),
    );
  });
});

// ---------------------------------------------------------------------------
// The registry we actually ship
// ---------------------------------------------------------------------------

describe("YAML model policy store — config/ai-models.yaml", () => {
  it("resolves facebook_content on the single-provider (OpenAI) registry", async () => {
    const policy = await makeStore(REAL_REGISTRY).getPolicy({
      tenantId: "tenant-1",
      task: "facebook_content",
    });

    expect(policy.policy).toMatchObject({
      vision: "single",
      primary: "cheap",
      escalate: ["mid", "top"],
      maxEscalations: 2,
    });
    expect(policy.tiers.cheap[0].provider).toBe("openai");
    expect(policy.tiers.cheap[0].pricing.inputPerMTokUsd).toBeGreaterThan(0);
    expect(policy.budget.maxCostPerGenerationUsd).toBeGreaterThan(0);
    expect(policy.registryVersion).toBe(1);
  });

  /**
   * Guards the owner decision of 15/08/2026 rather than a mechanism: putting a
   * Google model back into a tier while GOOGLE_AI_API_KEY is unset would fail at
   * generation time, not at load time. Delete this test in the same change that
   * re-enables Google.
   */
  it("ships no tier pointing at a provider other than OpenAI", async () => {
    const policy = await makeStore(REAL_REGISTRY).getPolicy({
      tenantId: "tenant-1",
      task: "facebook_content",
    });

    for (const tier of ["cheap", "mid", "top"] as const) {
      expect(policy.tiers[tier].length).toBeGreaterThan(0);
      expect(policy.tiers[tier].map((entry) => entry.provider)).toEqual(
        policy.tiers[tier].map(() => "openai"),
      );
    }
  });

  /**
   * Verified against the live API on 15/08/2026: sending `temperature` to a
   * GPT-5 model is a hard 400 ("Unsupported parameter"), classified
   * `bad_request` — terminal, no retry, no escalation, the whole post blocked.
   * `capabilities.temperature` defaults to TRUE in the schema, so a gpt-5 entry
   * that simply forgets the line reintroduces that 400 in production while every
   * scripted-provider test stays green. Checked over the WHOLE catalog, not just
   * the current tiers, because AI_MODEL_* can promote any declared model.
   *
   * The model-name check belongs in a test, not in adapter code: it pins a
   * vendor fact, it does not route anything.
   */
  it("declares temperature: false on every GPT-5 family model in the catalog", () => {
    const registry = parseYaml(readFileSync(REAL_REGISTRY, "utf8")) as {
      models: Record<string, { model: string; capabilities: { temperature?: boolean } }>;
    };

    const offenders = Object.entries(registry.models)
      .filter(([, entry]) => /^gpt-5/u.test(entry.model))
      .filter(([, entry]) => entry.capabilities.temperature !== false)
      .map(([key]) => key);

    expect(offenders).toEqual([]);
  });

  /** The other half of the same fact: a non-reasoning model must NOT be muted. */
  it("keeps temperature enabled on the non-reasoning models", () => {
    const registry = parseYaml(readFileSync(REAL_REGISTRY, "utf8")) as {
      models: Record<string, { model: string; capabilities: { temperature?: boolean } }>;
    };

    const muted = Object.entries(registry.models)
      .filter(([, entry]) => /^gpt-4/u.test(entry.model))
      .filter(([, entry]) => entry.capabilities.temperature === false)
      .map(([key]) => key);

    expect(muted).toEqual([]);
  });

  it("still asks for the temperature it wants — dropping it is the engine's job", async () => {
    const policy = await makeStore(REAL_REGISTRY).getPolicy({
      tenantId: "tenant-1",
      task: "facebook_content",
    });

    expect(policy.policy.temperature).toBe(0.8);
  });

  /**
   * The output budget is shared by reasoning tokens and the answer. 900 left
   * gpt-5-mini emitting nothing at all on 4 of 4 real runs (15/08/2026), so the
   * floor is pinned here rather than left to drift back down.
   */
  it("gives the caption task enough output budget for a reasoning model", async () => {
    const policy = await makeStore(REAL_REGISTRY).getPolicy({
      tenantId: "tenant-1",
      task: "facebook_content",
    });

    expect(policy.policy.maxOutputTokens).toBeGreaterThanOrEqual(2_000);
  });

  it("serves every declared task", async () => {
    const store = makeStore(REAL_REGISTRY);
    for (const task of ["facebook_content", "product_understanding", "caption_dedupe_check", "difficult_content"] as const) {
      const policy = await store.getPolicy({ tenantId: "tenant-1", task });
      expect(policy.task).toBe(task);
    }
  });

  it("rejects a task that is not in the registry", async () => {
    const path = writeTemp(
      "only-facebook.yaml",
      `version: 1
models:
  "google:a":
    provider: google
    model: a
    pricing: { inputPerMTokUsd: 1, outputPerMTokUsd: 2 }
    capabilities: { vision: true, structuredOutput: true, maxOutputTokens: 100 }
tiers:
  cheap: ["google:a"]
tasks:
  facebook_content:
    vision: single
    primary: cheap
    escalate: []
    maxEscalations: 0
    maxOutputTokens: 900
    timeoutMs: 1000
budget:
  maxCostPerGenerationUsd: 0.05
  dailyCostPerTenantUsd: 5
`,
    );
    await expectModelNotConfigured(
      makeStore(path).getPolicy({ tenantId: "t1", task: "difficult_content" }),
    );
  });

  it("caches within the TTL — the file is read once for repeated calls", async () => {
    const path = writeTemp(
      "cached.yaml",
      `version: 7
models:
  "google:a":
    provider: google
    model: a
    pricing: { inputPerMTokUsd: 1, outputPerMTokUsd: 2 }
    capabilities: { vision: true, structuredOutput: true, maxOutputTokens: 100 }
tiers:
  cheap: ["google:a"]
tasks:
  facebook_content:
    vision: single
    primary: cheap
    escalate: []
    maxEscalations: 0
    maxOutputTokens: 900
    timeoutMs: 1000
budget:
  maxCostPerGenerationUsd: 0.05
  dailyCostPerTenantUsd: 5
`,
    );
    const store = makeStore(path);
    await store.getPolicy({ tenantId: "t1", task: "facebook_content" });

    // Corrupt the file: a cached read must not notice within the TTL.
    writeFileSync(path, "not: [valid", "utf8");
    const second = await store.getPolicy({ tenantId: "t1", task: "facebook_content" });
    expect(second.registryVersion).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// AI_MODEL_CHEAP / _MID / _TOP — swap a tier without editing the file
// ---------------------------------------------------------------------------

describe("YAML model policy store — env tier override", () => {
  it("replaces the named tier with the chosen model", async () => {
    const policy = await makeStore(REAL_REGISTRY, { cheap: "openai:gpt-4o-mini" }).getPolicy({
      tenantId: "t1",
      task: "facebook_content",
    });

    expect(policy.tiers.cheap.map((entry) => entry.key)).toEqual(["openai:gpt-4o-mini"]);
    expect(policy.tiers.cheap[0].model).toBe("gpt-4o-mini");
    // Untouched tiers keep whatever the file says.
    expect(policy.tiers.mid.length).toBeGreaterThan(0);
  });

  it("carries the overridden model's own capabilities, not the replaced one's", async () => {
    const muted = await makeStore(REAL_REGISTRY, { cheap: "openai:gpt-5-mini" }).getPolicy({
      tenantId: "t1",
      task: "facebook_content",
    });
    const free = await makeStore(REAL_REGISTRY, { cheap: "openai:gpt-4.1-mini" }).getPolicy({
      tenantId: "t1",
      task: "facebook_content",
    });

    expect(muted.tiers.cheap[0].capabilities.temperature).toBe(false);
    expect(free.tiers.cheap[0].capabilities.temperature).toBe(true);
  });

  it("can point every tier at one model", async () => {
    const policy = await makeStore(REAL_REGISTRY, {
      cheap: "openai:gpt-4.1-mini",
      mid: "openai:gpt-4.1-mini",
      top: "openai:gpt-4.1-mini",
    }).getPolicy({ tenantId: "t1", task: "facebook_content" });

    expect((["cheap", "mid", "top"] as const).map((tier) => policy.tiers[tier][0]?.model)).toEqual([
      "gpt-4.1-mini",
      "gpt-4.1-mini",
      "gpt-4.1-mini",
    ]);
  });

  // A typo must stop the process and say what it could have said, rather than
  // surface later as a puzzling MODEL_NOT_CONFIGURED mid-generation.
  it("refuses a model key that is not declared, and lists the ones that are", async () => {
    const error = await expectModelNotConfigured(
      makeStore(REAL_REGISTRY, { mid: "openai:gpt-6-turbo" }).getPolicy({
        tenantId: "t1",
        task: "facebook_content",
      }),
    );

    expect(error.message).toContain("AI_MODEL_MID");
    expect(error.message).toContain("openai:gpt-6-turbo");
    expect(error.message).toContain("openai:gpt-4.1-mini");
    expect(error.context.tier).toBe("mid");
  });

  it("ignores blank and absent values instead of emptying a tier", async () => {
    const policy = await makeStore(REAL_REGISTRY, { cheap: "   ", top: undefined }).getPolicy({
      tenantId: "t1",
      task: "facebook_content",
    });

    expect(policy.tiers.cheap[0].model).toBe("gpt-4.1-mini");
    expect(policy.tiers.top.length).toBeGreaterThan(0);
  });

  it("can promote a model the shipped ladder deliberately leaves out", async () => {
    const policy = await makeStore(REAL_REGISTRY, { top: "openai:gpt-5" }).getPolicy({
      tenantId: "t1",
      task: "facebook_content",
    });

    expect(policy.tiers.top[0].model).toBe("gpt-5");
  });
});
