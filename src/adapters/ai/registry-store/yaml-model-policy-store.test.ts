import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

function makeStore(filePath: string) {
  return makeYamlModelPolicyStore({
    filePath,
    clock: makeFixedClock(),
    logger: makeFakeLogger(),
    ttlMs: 60_000,
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
  it("resolves facebook_content: Google primary, OpenAI fallback in the same tier", async () => {
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
    expect(policy.tiers.cheap[0].provider).toBe("google");
    expect(policy.tiers.cheap[1].provider).toBe("openai");
    expect(policy.tiers.cheap[0].pricing.inputPerMTokUsd).toBeGreaterThan(0);
    expect(policy.budget.maxCostPerGenerationUsd).toBeGreaterThan(0);
    expect(policy.registryVersion).toBe(1);
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
