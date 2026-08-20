import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";

import type { TenantId } from "@/core/domain/tenant-context";

import { makeRedisAiCache } from "@/adapters/ai/cache/redis-cache";
import { makeDbPromptStore } from "@/adapters/ai/prompt-store/db-prompt-store";
import {
  BUILT_IN_TEMPLATES,
  makeStaticPromptStore,
} from "@/adapters/ai/prompt-store/static-prompt-store";
import { makeCachedModelPolicyStore } from "@/adapters/ai/registry-store/cached-model-policy-store";
import { makeYamlModelPolicyStore } from "@/adapters/ai/registry-store/yaml-model-policy-store";
import { makeSystemClock } from "@/adapters/clock/system-clock";
import { DrizzleAiModelPolicyOverrideRepo } from "@/adapters/db/ai-model-policy-override-repo.drizzle";
import { makeDrizzleGenerationLog } from "@/adapters/db/ai-generation-log.drizzle";
import { DrizzleAiPromptTemplateRepo } from "@/adapters/db/ai-prompt-template-repo.drizzle";
import { makeDbHandle } from "@/adapters/db/client";
import {
  aiGenerations,
  aiModelPolicyOverrides,
  aiPromptTemplates,
  tenants,
} from "@/adapters/db/schema";
import { makePinoLogger } from "@/adapters/logging/pino-logger";
import { createRedisConnection } from "@/adapters/queue/redis-connection";
import { makeContentEngine } from "@/core/ai/content-engine";
import { makeScriptedProvider } from "@/core/ai/testing";
import { AppError } from "@/core/domain/errors";
import type { AIProviderAdapter, ModelPolicyStore, NormalizedAIRequest } from "@/core/ports/ai";
import { makeGenerateCaptions } from "@/core/usecases/generate-captions";
import { makeManagePromptTemplates } from "@/core/usecases/manage-prompt-templates";

/**
 * Sprint-5 smoke test for the AI persistence layer, on a REAL Postgres + REAL
 * Redis, with a scripted provider instead of a paid model (no token is spent).
 *
 * What it proves:
 *   a) every attempt lands in `ai_generation` — including the one that failed
 *      validation and the one that failed at the provider;
 *   b) prompt CRUD: create v2 -> activate -> the NEXT generation renders v2;
 *   c) a body missing a required variable is refused (INVALID_INPUT);
 *   d) a body reading a non-whitelisted field is refused;
 *   e) a per-tenant `ai_model_policy_override` changes the model actually used;
 *   f) the Redis hot cache serves the second lookup without touching YAML or DB.
 *
 *   DATABASE_URL=... REDIS_URL=... NODE_ENV=development \
 *     pnpm exec tsx scripts/ai-persistence-smoke.ts
 */

const TENANT_NAME = "AI persistence smoke";
const PLATFORM = "facebook";
const TASK = "facebook_content" as const;

const PRODUCT = {
  name: "MG0SV6055-PIERA",
  description:
    "Đầm lụa tơ óng dáng suông, tay lỡ, có lớp lót mềm. Phom rộng thoải mái, dễ mặc đi làm và đi tiệc.",
  category: "Đầm",
  season: "Xuân Hè",
};

/** Valid structured output for this product — passes all four stages. */
const GOOD_OUTPUT = {
  title: "NHẸ NHƯ MỘT LỜI HẸN",
  body: "Chất liệu lụa tơ óng bắt sáng dịu, dáng suông thoải mái cho cả ngày dài. Tay lỡ thanh lịch, lớp lót mềm mại nâng niu làn da.",
  hashtags: ["#dam", "#lualatoong", "#xuanhe"],
  claims: [
    { field: "material", statement: "lụa tơ óng", sourceText: "Đầm lụa tơ óng" },
    { field: "other", statement: "dáng suông", sourceText: "dáng suông" },
    { field: "season", statement: "xuân hè", sourceText: "Xuân Hè" },
  ],
  confidence: 0.9,
};

/** Same shape, but the body invents a price — validation stage 4 rejects it. */
const PRICE_OUTPUT = {
  ...GOOD_OUTPUT,
  body: `${GOOD_OUTPUT.body} Giá chỉ 1.250.000 cho tuần này.`,
};

const logger = makePinoLogger({
  level: process.env.LOG_LEVEL === "debug" ? "debug" : "info",
  pretty: true,
  base: { service: "ai-persistence-smoke" },
});

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

function step(name: string): void {
  logger.info(`--- ${name} ---`);
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL ?? "";
  const redisUrl = process.env.REDIS_URL ?? "";
  assert(databaseUrl, "DATABASE_URL is required");
  assert(redisUrl, "REDIS_URL is required");

  const handle = makeDbHandle({ url: databaseUrl });
  const db = handle.db;
  const redis = createRedisConnection({ url: redisUrl, logger });
  const clock = makeSystemClock();

  const tenantId = randomUUID() as TenantId;
  await db.insert(tenants).values({ id: tenantId, name: TENANT_NAME, status: "active" });

  try {
    // --- wiring -----------------------------------------------------------
    const promptRepo = new DrizzleAiPromptTemplateRepo(db, logger);
    const overrideRepo = new DrizzleAiModelPolicyOverrideRepo(db, logger);

    // Counting proxies: the only honest way to prove "the 2nd call touched
    // neither YAML nor the database".
    const yamlStore = makeYamlModelPolicyStore({
      filePath: process.env.AI_MODELS_CONFIG_PATH ?? "./config/ai-models.yaml",
      clock,
      logger,
      ttlMs: 60_000,
    });
    let yamlReads = 0;
    let overrideReads = 0;
    const countingYaml: ModelPolicyStore = {
      getPolicy: (query) => {
        yamlReads += 1;
        return yamlStore.getPolicy(query);
      },
    };
    const countingOverrides = {
      findOverride: (query: { tenantId: TenantId; task: typeof TASK }) => {
        overrideReads += 1;
        return overrideRepo.findOverride(query);
      },
    };

    const policies = makeCachedModelPolicyStore({
      base: countingYaml,
      overrides: countingOverrides,
      cache: makeRedisAiCache(redis, logger),
      logger,
      ttlMs: 60_000,
    });

    const prompts = makeDbPromptStore({
      repo: promptRepo,
      builtIn: makeStaticPromptStore(),
      logger,
    });
    const generationLog = makeDrizzleGenerationLog({ db, logger, newId: () => randomUUID() });
    const promptTemplates = makeManagePromptTemplates({
      templates: promptRepo,
      builtIn: BUILT_IN_TEMPLATES,
      logger,
      newId: () => randomUUID(),
    });

    const sentRequests: NormalizedAIRequest[] = [];
    function engineWith(provider: AIProviderAdapter) {
      const spy: AIProviderAdapter = {
        provider: provider.provider,
        capabilities: (model) => provider.capabilities(model),
        complete: async (request) => {
          sentRequests.push(request);
          return provider.complete(request);
        },
      };
      return makeContentEngine({
        providers: { google: spy, openai: spy },
        policies,
        prompts,
        generationLog,
        logger,
        clock,
        ids: { newId: () => randomUUID() },
      });
    }

    const captionInput = {
      tenantId,
      product: PRODUCT,
      channels: [
        { channelId: "fbpage-a", platform: "facebook" as const, contentType: "photo_post" as const },
      ],
      vision: { mode: "none" as const },
      batchId: "batch-smoke-1",
      productCode: PRODUCT.name,
    };

    // --- (a) every attempt is logged, failures included -------------------
    step("a) generation attempts land in ai_generation (fail + escalation + pass)");
    const flakyProvider = makeScriptedProvider("google", [
      // attempt 1: infra failure -> provider fallback inside the cheap tier
      { kind: "fail", code: "AI_RATE_LIMITED", failureKind: "rate_limited" },
      // attempt 2: answers, but the body carries a price -> validation fails
      { kind: "ok", output: PRICE_OUTPUT },
      // attempt 3 (escalated tier): clean output
      { kind: "ok", output: GOOD_OUTPUT },
    ]);
    const result = await makeGenerateCaptions({
      contentEngine: engineWith(flakyProvider),
      logger,
    })(captionInput);

    assert(result.generated.length === 1, "one caption must be generated");
    const first = result.generated[0];
    assert(first.attempts === 3, `expected 3 attempts, got ${first.attempts}`);
    assert(first.fallbackUsed, "the rate-limited attempt must have triggered a provider fallback");
    assert(first.escalations === 1, `expected 1 escalation, got ${first.escalations}`);

    const rows = await db
      .select()
      .from(aiGenerations)
      .where(eq(aiGenerations.tenantId, tenantId))
      .orderBy(aiGenerations.attemptNo);
    assert(rows.length === 3, `expected 3 ai_generation rows, got ${rows.length}`);
    assert(rows[0].status === "provider_error", "attempt 1 must be logged as provider_error");
    assert(rows[0].failureKind === "rate_limited", "attempt 1 must keep its failure kind");
    assert(rows[1].status === "validation_failed", "attempt 2 must be logged as validation_failed");
    assert(rows[1].validationStageFailed === 4, "the price rule lives in stage 4");
    assert(rows[2].status === "passed", "attempt 3 must be logged as passed");
    assert(rows[2].tier === "mid", `escalated attempt must run on mid, got ${rows[2].tier}`);
    assert(rows[2].batchId === "batch-smoke-1", "batch context must be stored");
    assert(rows[2].productCode === PRODUCT.name, "product context must be stored");
    assert(Number(rows[2].costUsd) > 0, "cost must be priced from the registry");
    logger.info("ai_generation rows", {
      rows: rows.map((row) => ({
        attempt: row.attemptNo,
        status: row.status,
        tier: row.tier,
        model: row.model,
        stage: row.validationStageFailed,
        cost_usd: row.costUsd,
      })),
    });

    // --- (c/d) template validation ----------------------------------------
    step("c) a body missing {{product.name}} is refused");
    await expectAppError(
      () =>
        promptTemplates.createVersion({
          tenantId,
          task: TASK,
          platform: PLATFORM,
          name: "thiếu biến",
          systemPrompt: "SYSTEM",
          body: "Chỉ có {{constraints}}",
          changelog: "thử",
        }),
      "INVALID_INPUT",
      "missing_variables",
    );

    step("d) a body reading a non-whitelisted field is refused");
    await expectAppError(
      () =>
        promptTemplates.createVersion({
          tenantId,
          task: TASK,
          platform: PLATFORM,
          name: "biến lạ",
          systemPrompt: "SYSTEM",
          body: "{{product.name}} {{constraints}} giá {{product.price}}",
          changelog: "thử",
        }),
      "INVALID_INPUT",
      "unknown_variables",
    );

    // --- (b) create v2 -> activate -> generation renders v2 ----------------
    step("b) create v2, activate it, and generate with it");
    const marker = "DẤU HIỆU BẢN V2";
    const created = await promptTemplates.createVersion({
      tenantId,
      task: TASK,
      platform: PLATFORM,
      name: "Giọng riêng của shop",
      systemPrompt: `SYSTEM V2 ${marker}`,
      body: `${marker}\nTên: {{product.name}}\nMô tả: {{product.description}}\n{{constraints}}\n{{otherCaptions}}\n{{previousFailures}}`,
      changelog: "thêm giọng riêng cho shop",
    });
    assert(created.template.version === 2, `expected v2, got v${created.template.version}`);
    assert(created.template.status === "draft", "a new version starts as draft");
    logger.info("prompt version created", {
      version: created.template.version,
      warnings: created.warnings,
    });

    const beforeActivation = await prompts.getActive({ tenantId, task: TASK, platform: PLATFORM });
    assert(beforeActivation?.version === 1, "an inactive v2 must not be served yet");

    await promptTemplates.activateVersion({
      tenantId,
      task: TASK,
      platform: PLATFORM,
      version: 2,
    });

    sentRequests.length = 0;
    const cleanProvider = makeScriptedProvider("google", [{ kind: "ok", output: GOOD_OUTPUT }]);
    await makeGenerateCaptions({ contentEngine: engineWith(cleanProvider), logger })(captionInput);

    const rendered = sentRequests.at(-1);
    assert(rendered, "the provider must have been called");
    assert(rendered.system.includes(marker), "system prompt must come from v2");
    assert(rendered.messages[0].parts[0].type === "text", "first part is the user prompt");
    const userPrompt = rendered.messages[0].parts[0].text;
    assert(userPrompt.includes(marker), "user prompt must come from v2");
    assert(userPrompt.includes(PRODUCT.name), "the product name must be rendered");
    assert(!userPrompt.includes("{{"), "no placeholder may survive rendering");

    const v2Rows = await db
      .select()
      .from(aiGenerations)
      .where(and(eq(aiGenerations.tenantId, tenantId), eq(aiGenerations.promptVersion, 2)));
    assert(v2Rows.length === 1, "the generation must be logged against prompt version 2");
    logger.info("generation used prompt v2", {
      prompt_template_id: v2Rows[0].promptTemplateId,
      prompt_version: v2Rows[0].promptVersion,
    });

    const listing = await promptTemplates.listVersions({
      tenantId,
      task: TASK,
      platform: PLATFORM,
    });
    assert(
      listing.versions.filter((item) => item.status === "active").length === 1,
      "exactly one active version",
    );
    assert(listing.nextVersion === 3, `next version must be 3, got ${listing.nextVersion}`);

    // --- (f) Redis cache hit ----------------------------------------------
    step("f) the registry hot cache serves the second lookup from Redis");
    await policies.invalidate({ tenantId });
    yamlReads = 0;
    overrideReads = 0;

    const cold = await policies.getPolicy({ tenantId, task: TASK });
    const warm = await policies.getPolicy({ tenantId, task: TASK });
    assert(yamlReads === 1, `YAML must be read once, got ${yamlReads}`);
    assert(overrideReads === 1, `the override table must be read once, got ${overrideReads}`);
    assert(cold.policy.primary === warm.policy.primary, "the cached policy must match");
    const cacheKey = `ai:policy:v1:${tenantId}:${TASK}`;
    assert((await redis.exists(cacheKey)) === 1, "the policy must be stored in Redis");
    const ttl = await redis.pttl(cacheKey);
    assert(ttl > 0 && ttl <= 60_000, `TTL must be short, got ${ttl}ms`);
    logger.info("cache stats", { ...policies.stats(), ttl_ms: ttl, cache_key: cacheKey });

    // --- (e) per-tenant override ------------------------------------------
    step("e) a tenant override changes the model actually used");
    await db.insert(aiModelPolicyOverrides).values({
      id: randomUUID(),
      tenantId,
      task: TASK,
      override: { primary: "top", maxEscalations: 0 },
      note: "smoke test",
    });
    await policies.invalidate({ tenantId, task: TASK });

    sentRequests.length = 0;
    const topProvider = makeScriptedProvider("google", [{ kind: "ok", output: GOOD_OUTPUT }]);
    await makeGenerateCaptions({ contentEngine: engineWith(topProvider), logger })(captionInput);

    const overriddenRow = await db
      .select()
      .from(aiGenerations)
      .where(and(eq(aiGenerations.tenantId, tenantId), eq(aiGenerations.tier, "top")));
    assert(overriddenRow.length === 1, "the override must route the generation to the top tier");
    logger.info("override applied", {
      tier: overriddenRow[0].tier,
      model: overriddenRow[0].model,
    });

    // A broken override must fail loudly rather than silently reverting to YAML.
    step("e2) a malformed override fails loudly instead of falling back to YAML");
    await db
      .update(aiModelPolicyOverrides)
      .set({ override: { primary: "not-a-tier" } })
      .where(
        and(
          eq(aiModelPolicyOverrides.tenantId, tenantId),
          eq(aiModelPolicyOverrides.task, TASK),
        ),
      );
    await policies.invalidate({ tenantId, task: TASK });
    await expectAppError(
      () => policies.getPolicy({ tenantId, task: TASK }),
      "MODEL_NOT_CONFIGURED",
      "issues",
    );

    logger.info("AI PERSISTENCE SMOKE PASSED");
  } finally {
    // Clean up this tenant's rows; cascades take the AI tables with it.
    await db.delete(aiGenerations).where(eq(aiGenerations.tenantId, tenantId));
    await db.delete(aiPromptTemplates).where(eq(aiPromptTemplates.tenantId, tenantId));
    await db
      .delete(aiModelPolicyOverrides)
      .where(eq(aiModelPolicyOverrides.tenantId, tenantId));
    await db.delete(tenants).where(eq(tenants.id, tenantId));
    await redis.quit();
    await handle.close();
  }
}

async function expectAppError(
  run: () => Promise<unknown>,
  code: string,
  contextKey: string,
): Promise<void> {
  try {
    await run();
  } catch (error) {
    assert(AppError.is(error), `expected an AppError, got ${String(error)}`);
    assert(error.code === code, `expected ${code}, got ${error.code}`);
    assert(
      error.context[contextKey] !== undefined,
      `expected context.${contextKey} on the error`,
    );
    logger.info("rejected as expected", {
      error_code: error.code,
      user_message: error.userMessage,
      [contextKey]: error.context[contextKey],
    });
    return;
  }
  throw new Error(`ASSERTION FAILED: expected ${code} but the call succeeded`);
}

main().catch((error) => {
  // The pino adapter already serialises AppError; handing it a pre-flattened
  // toLogObject() loses every field and prints [object Object].
  logger.error("AI PERSISTENCE SMOKE FAILED", { err: error });
  process.exitCode = 1;
});
