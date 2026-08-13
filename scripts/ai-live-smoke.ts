import { randomUUID } from "node:crypto";
import { deflateSync } from "node:zlib";

import { asc, eq } from "drizzle-orm";

import { makeRedisAiCache } from "@/adapters/ai/cache/redis-cache";
import { makeGoogleProviderAdapter } from "@/adapters/ai/google/google-provider";
import { makeOpenAIProviderAdapter } from "@/adapters/ai/openai/openai-provider";
import { makeDbPromptStore } from "@/adapters/ai/prompt-store/db-prompt-store";
import { makeStaticPromptStore } from "@/adapters/ai/prompt-store/static-prompt-store";
import {
  makeCachedModelPolicyStore,
  type CachedModelPolicyStore,
} from "@/adapters/ai/registry-store/cached-model-policy-store";
import { makeYamlModelPolicyStore } from "@/adapters/ai/registry-store/yaml-model-policy-store";
import { makeSystemClock } from "@/adapters/clock/system-clock";
import { makeDrizzleGenerationLog } from "@/adapters/db/ai-generation-log.drizzle";
import { DrizzleAiModelPolicyOverrideRepo } from "@/adapters/db/ai-model-policy-override-repo.drizzle";
import { DrizzleAiPromptTemplateRepo } from "@/adapters/db/ai-prompt-template-repo.drizzle";
import { makeDbHandle } from "@/adapters/db/client";
import { aiGenerations, aiModelPolicyOverrides, products, tenants } from "@/adapters/db/schema";
import { makePinoLogger } from "@/adapters/logging/pino-logger";
import { createRedisConnection } from "@/adapters/queue/redis-connection";
import { makeContentEngine } from "@/core/ai/content-engine";
import { makeScriptedProvider } from "@/core/ai/testing";
import { loadAiConfig } from "@/composition/config";
import { AppError } from "@/core/domain/errors";
import type { AIProviderAdapter, AITier, ModelPolicyStore } from "@/core/ports/ai";
import type { VisionInput } from "@/core/ports/content-engine";
import { makeGenerateCaptions } from "@/core/usecases/generate-captions";

/**
 * LIVE smoke against REAL paid providers (Sprint 8B). Everything else in the AI
 * vertical is covered by mocked unit tests; this script exists to check the
 * assumptions a mock cannot check:
 *
 *   A1 Gemini accepts our `responseJsonSchema` (structured output as sent);
 *   A2 OpenAI strict mode accepts the same schema after minItems/maxItems are
 *      stripped;
 *   A3 the registry model strings actually exist at the providers;
 *   A4 real error shapes map onto our failure kinds;
 *   A5 token counts / cost / latency are what the cost model assumes;
 *   A6 the 4 validation stages behave on REAL model output, not fixtures.
 *
 * MONEY GUARD: every provider call goes through a ledger with a hard ceiling
 * (AI_LIVE_MAX_CALLS, default 12). The ceiling is checked BEFORE the request
 * leaves, so an unexpected retry loop cannot burn budget.
 *
 *   DATABASE_URL=... REDIS_URL=... GOOGLE_AI_API_KEY=... OPENAI_API_KEY=... \
 *     pnpm exec tsx scripts/ai-live-smoke.ts
 *
 * Optional:
 *   AI_LIVE_STEPS=google-synthetic,google-real   pick a subset (resume a run
 *                                                without paying twice)
 *   AI_LIVE_MAX_CALLS=4                          lower the ceiling
 *   AI_LIVE_PRODUCT_CODE=MGKVX6310               real product to read from DB
 *
 * ⚠️ ADR-001: the Google key MUST be a PAID-tier project before real shop data
 * is sent — the free tier grants Google training rights. This script cannot
 * verify the tier of a key; steps that send real sheet data say so out loud.
 */

const DEFAULT_MAX_CALLS = 12;

/**
 * Output of this script runs with PAID keys and gets pasted into chats/logs.
 * Providers should never echo a key back, but belt-and-braces: strip anything
 * that looks like one before printing raw error payloads.
 */
function redactApiKeys(text: string): string {
  return text
    .replace(/AIza[\w-]{20,}/g, "<redacted-google-key>")
    .replace(/sk-[\w-]{20,}/g, "<redacted-openai-key>");
}
const PLATFORM = "facebook" as const;

/** Fully invented product — safe to send even to a free-tier key (A1 probe). */
const SYNTHETIC_PRODUCT = {
  name: "Zeltavia",
  description:
    "VÁY THỬ NGHIỆM ABC123, 2 LỚP, CHUN EO\nCÓ KÈM QUẦN BẢO HỘ\nĐộ co giãn: KHÔNG CO GIÃN\nKết cấu: TAY LỠ, CỔ TRÒN",
  category: "Váy xoè",
  season: "Xuân hè 2026",
};

const logger = makePinoLogger({
  level: process.env.LOG_LEVEL === "debug" ? "debug" : "warn",
  pretty: true,
  base: { service: "ai-live-smoke" },
});

// ---------------------------------------------------------------------------
// Call ledger — the money guard
// ---------------------------------------------------------------------------

interface LedgerRow {
  call: number;
  step: string;
  provider: string;
  model: string;
  purpose: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  costUsd: number;
  latencyMs: number;
  result: string;
}

class CallLedger {
  readonly rows: LedgerRow[] = [];
  private used = 0;

  constructor(private readonly max: number) {}

  get spent(): number {
    return this.used;
  }

  /** Throws BEFORE the HTTP request when the ceiling is reached. */
  reserve(step: string, provider: string, model: string): number {
    if (this.used >= this.max) {
      throw new AppError("INTERNAL", {
        message: `Live call budget exhausted (${this.max} calls) — refusing to spend more`,
        userMessage: "Đã hết hạn mức gọi AI thật cho lần chạy này.",
        context: { step, provider, model, max_calls: this.max },
      });
    }
    this.used += 1;
    return this.used;
  }

  record(row: LedgerRow): void {
    this.rows.push(row);
  }

  /**
   * Prices come from `ai_generation` (registry pricing applied to the tokens the
   * provider reported). Matched on (provider, model) in call order; a mismatch
   * is printed instead of guessed, so no number in this table is invented.
   */
  applyCosts(attempts: readonly { provider: string; model: string; costUsd: number }[]): void {
    const queues = new Map<string, number[]>();
    for (const attempt of attempts) {
      const key = `${attempt.provider}:${attempt.model}`;
      const list = queues.get(key) ?? [];
      list.push(attempt.costUsd);
      queues.set(key, list);
    }
    for (const row of this.rows) {
      const list = queues.get(`${row.provider}:${row.model}`);
      const cost = list?.shift();
      if (cost === undefined) {
        row.result += " [no ai_generation row matched]";
        continue;
      }
      row.costUsd = cost;
    }
  }

  print(): void {
    console.log("\n=== LIVE CALL LEDGER ===");
    console.log(
      [
        "#".padEnd(3),
        "step".padEnd(22),
        "provider".padEnd(8),
        "model".padEnd(24),
        "in".padStart(6),
        "out".padStart(6),
        "cost$".padStart(9),
        "ms".padStart(7),
        "result",
      ].join(" "),
    );
    for (const row of this.rows) {
      console.log(
        [
          String(row.call).padEnd(3),
          row.step.slice(0, 22).padEnd(22),
          row.provider.padEnd(8),
          row.model.slice(0, 24).padEnd(24),
          String(row.inputTokens).padStart(6),
          String(row.outputTokens).padStart(6),
          row.costUsd.toFixed(6).padStart(9),
          String(row.latencyMs).padStart(7),
          row.result,
        ].join(" "),
      );
    }
    const cost = this.rows.reduce((sum, row) => sum + row.costUsd, 0);
    console.log(`calls used: ${this.used}/${this.max}   total cost (registry pricing): $${cost.toFixed(6)}`);
  }
}

/**
 * Wraps a real adapter so no call can escape the ledger. It also converts the
 * exact provider error into a ledger row, which is the whole point of the run:
 * we want the REAL failure shape written down.
 */
function metered(
  adapter: AIProviderAdapter,
  ledger: CallLedger,
  step: () => string,
  purpose: () => string,
): AIProviderAdapter {
  return {
    provider: adapter.provider,
    capabilities: (model) => adapter.capabilities(model),
    async complete(request) {
      const call = ledger.reserve(step(), adapter.provider, request.model);
      const startedAt = Date.now();
      try {
        const response = await adapter.complete(request);
        ledger.record({
          call,
          step: step(),
          provider: adapter.provider,
          model: request.model,
          purpose: purpose(),
          inputTokens: response.usage.inputTokens,
          outputTokens: response.usage.outputTokens,
          cachedTokens: response.usage.cachedTokens,
          costUsd: 0, // backfilled from ai_generation by ledger.applyCosts()
          latencyMs: response.latencyMs,
          result: `ok finish=${String(response.raw?.finishReason ?? "?")}`,
        });
        return response;
      } catch (error) {
        const appError = AppError.from(error, "AI_PROVIDER_ERROR", { step: step() });
        ledger.record({
          call,
          step: step(),
          provider: adapter.provider,
          model: request.model,
          purpose: purpose(),
          inputTokens: 0,
          outputTokens: 0,
          cachedTokens: 0,
          costUsd: 0,
          latencyMs: Date.now() - startedAt,
          result: `ERROR ${appError.code}/${String(appError.context.failure_kind ?? "?")}`,
        });
        console.log(`\n--- RAW PROVIDER ERROR (${adapter.provider}) ---`);
        console.log(
          redactApiKeys(
            JSON.stringify(
              {
                code: appError.code,
                message: appError.message,
                context: appError.context,
                cause_name:
                  appError.cause instanceof Error ? appError.cause.name : typeof appError.cause,
                cause_message:
                  appError.cause instanceof Error ? appError.cause.message.slice(0, 1500) : undefined,
              },
              null,
              2,
            ),
          ),
        );
        throw error;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Synthetic cover image (PNG built here — no binary fixture in the repo)
// ---------------------------------------------------------------------------

/** Minimal 256x256 RGB PNG with two flat bands, enough to prove the vision transport. */
function makeCoverPngBase64(): string {
  const size = 256;
  const raw = Buffer.alloc((size * 3 + 1) * size);
  let offset = 0;
  for (let y = 0; y < size; y += 1) {
    raw[offset] = 0; // filter type: none
    offset += 1;
    for (let x = 0; x < size; x += 1) {
      const top = y < size / 2;
      raw[offset] = top ? 235 : 120;
      raw[offset + 1] = top ? 220 : 90;
      raw[offset + 2] = top ? 200 : 80;
      offset += 3;
    }
  }

  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  return png.toString("base64");
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

interface StepContext {
  step: string;
  purpose: string;
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL ?? "";
  const redisUrl = process.env.REDIS_URL ?? "";
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  if (!redisUrl) throw new Error("REDIS_URL is required");

  // Fails here, naming the missing variable, before any container is touched.
  const aiConfig = loadAiConfig();

  const maxCalls = Number(process.env.AI_LIVE_MAX_CALLS ?? DEFAULT_MAX_CALLS);
  if (!Number.isInteger(maxCalls) || maxCalls <= 0) {
    throw new Error(`AI_LIVE_MAX_CALLS must be a positive integer, got "${process.env.AI_LIVE_MAX_CALLS}"`);
  }
  const selected = (process.env.AI_LIVE_STEPS ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const wanted = (name: string): boolean => selected.length === 0 || selected.includes(name);

  const ledger = new CallLedger(maxCalls);
  const handle = makeDbHandle({ url: databaseUrl });
  const db = handle.db;
  const redis = createRedisConnection({ url: redisUrl, logger });
  const clock = makeSystemClock();

  const tenantId = randomUUID();
  await db.insert(tenants).values({ id: tenantId, name: "AI live smoke", status: "active" });

  let current: StepContext = { step: "init", purpose: "-" };

  try {
    // --- wiring: real registry, real prompt store, real generation log ------
    const yaml: ModelPolicyStore = makeYamlModelPolicyStore({
      filePath: aiConfig.AI_MODELS_CONFIG_PATH,
      clock,
      logger,
      ttlMs: 60_000,
    });
    const policies = makeCachedModelPolicyStore({
      base: yaml,
      overrides: new DrizzleAiModelPolicyOverrideRepo(db, logger),
      cache: makeRedisAiCache(redis, logger),
      logger,
      ttlMs: 60_000,
    });
    const prompts = makeDbPromptStore({
      repo: new DrizzleAiPromptTemplateRepo(db, logger),
      builtIn: makeStaticPromptStore(),
      logger,
    });
    const generationLog = makeDrizzleGenerationLog({ db, logger, newId: () => randomUUID() });

    const google = metered(
      makeGoogleProviderAdapter({ apiKey: aiConfig.GOOGLE_AI_API_KEY, logger }),
      ledger,
      () => current.step,
      () => current.purpose,
    );
    const openai = metered(
      makeOpenAIProviderAdapter({ apiKey: aiConfig.OPENAI_API_KEY, logger }),
      ledger,
      () => current.step,
      () => current.purpose,
    );
    /** Google permanently rate-limited: the only honest way to reach OpenAI. */
    const brokenGoogle = makeScriptedProvider("google", [
      { kind: "fail", code: "AI_RATE_LIMITED", failureKind: "rate_limited" },
    ]);

    const engineWith = (providers: Partial<Record<"google" | "openai", AIProviderAdapter>>) =>
      makeGenerateCaptions({
        contentEngine: makeContentEngine({
          providers,
          policies,
          prompts,
          generationLog,
          logger,
          clock,
          ids: { newId: () => randomUUID() },
        }),
        logger,
      });

    const realProduct = await loadRealProduct(db);

    const runStep = async (
      step: string,
      purpose: string,
      run: () => Promise<void>,
    ): Promise<void> => {
      if (!wanted(step)) {
        console.log(`\n### ${step}: SKIPPED (not in AI_LIVE_STEPS)`);
        return;
      }
      current = { step, purpose };
      console.log(`\n### ${step} — ${purpose}`);
      try {
        await run();
      } catch (error) {
        const appError = AppError.from(error, "INTERNAL", { step });
        console.log(`### ${step} FAILED: ${appError.code} — ${appError.message}`);
        console.log(JSON.stringify(appError.context, null, 2));
        if (appError.code === "INTERNAL" && String(appError.context.max_calls ?? "") !== "") throw error;
      }
    };

    const captionRun = async (input: {
      engine: ReturnType<typeof engineWith>;
      product: typeof SYNTHETIC_PRODUCT;
      vision: VisionInput;
      maxBodyChars?: number;
      productCode: string;
    }): Promise<void> => {
      const result = await input.engine({
        tenantId,
        product: input.product,
        channels: [{ channelId: "fb-live-smoke", platform: PLATFORM, contentType: "photo_post" }],
        vision: input.vision,
        constraints: input.maxBodyChars ? { maxBodyChars: input.maxBodyChars } : undefined,
        batchId: "live-smoke",
        productCode: input.productCode,
      });
      for (const item of result.generated) {
        console.log(
          JSON.stringify(
            {
              provider: item.provider,
              model: item.model,
              tier: item.tier,
              attempts: item.attempts,
              escalations: item.escalations,
              fallback_used: item.fallbackUsed,
              cost_usd: item.costUsd,
              latency_ms: item.latencyMs,
            },
            null,
            2,
          ),
        );
        console.log("--- CAPTION ---");
        console.log(item.caption.text);
        console.log("--- CLAIMS ---");
        console.log(JSON.stringify(item.caption.content.claims, null, 2));
      }
    };

    // --- A1: does Gemini accept responseJsonSchema? (fake data, any tier) ---
    await runStep(
      "google-synthetic",
      "Gemini structured output on INVENTED data (safe on a free-tier key)",
      () =>
        captionRun({
          engine: engineWith({ google }),
          product: SYNTHETIC_PRODUCT,
          vision: { mode: "none" },
          productCode: "SYNTH-ABC123",
        }),
    );

    // --- A6: real sheet data end to end (PAID TIER REQUIRED) ----------------
    await runStep(
      "google-real",
      `real sheet product ${realProduct.code} — PAID TIER REQUIRED (ADR-001)`,
      () =>
        captionRun({
          engine: engineWith({ google }),
          product: realProduct.content,
          vision: { mode: "none" },
          productCode: realProduct.code,
        }),
    );

    // --- vision transport with exactly one cover image -----------------------
    await runStep("google-vision", "one cover image inline (synthetic PNG)", () =>
      captionRun({
        engine: engineWith({ google }),
        product: SYNTHETIC_PRODUCT,
        vision: {
          mode: "single",
          image: {
            ref: "synthetic-cover.png",
            mimeType: "image/png",
            dataBase64: makeCoverPngBase64(),
            kind: "unknown",
          },
        },
        productCode: "SYNTH-ABC123",
      }),
    );

    // --- escalation ladder on real models (cheap -> mid -> top) -------------
    // A 40-char body cap can never be satisfied, so stage 2 fails at every tier
    // and we get to watch the real ladder plus the failure feedback loop.
    await runStep(
      "escalation-ladder",
      "forced stage-2 failure: cheap -> mid -> top on real Gemini models",
      () =>
        captionRun({
          engine: engineWith({ google }),
          product: SYNTHETIC_PRODUCT,
          vision: { mode: "none" },
          maxBodyChars: 40,
          productCode: "SYNTH-ABC123",
        }),
    );

    // --- A2: OpenAI strict schema, reached through the fallback road --------
    await runStep(
      "openai-fallback-cheap",
      "Google rate-limited -> OpenAI same tier, strict json_schema",
      () =>
        captionRun({
          engine: engineWith({ google: brokenGoogle, openai }),
          product: SYNTHETIC_PRODUCT,
          vision: { mode: "none" },
          productCode: "SYNTH-ABC123",
        }),
    );

    await runStep("openai-fallback-mid", "same, on the mid tier model", async () => {
      await setTierOverride(db, policies, tenantId, "mid");
      await captionRun({
        engine: engineWith({ google: brokenGoogle, openai }),
        product: SYNTHETIC_PRODUCT,
        vision: { mode: "none" },
        productCode: "SYNTH-ABC123",
      });
    });

    // --- what actually landed in ai_generation ------------------------------
    const rows = await db
      .select()
      .from(aiGenerations)
      .where(eq(aiGenerations.tenantId, tenantId))
      .orderBy(asc(aiGenerations.createdAt), asc(aiGenerations.attemptNo));

    console.log("\n=== ai_generation rows ===");
    for (const row of rows) {
      console.log(
        JSON.stringify({
          attempt: row.attemptNo,
          status: row.status,
          tier: row.tier,
          provider: row.provider,
          model: row.model,
          in: row.inputTokens,
          out: row.outputTokens,
          cached: row.cachedTokens,
          cost_usd: row.costUsd,
          latency_ms: row.latencyMs,
          stage: row.validationStageFailed,
          failure_kind: row.failureKind,
          error_code: row.errorCode,
          fallback: row.fallbackUsed,
          escalated_from: row.escalationFrom,
          rules: row.validationFailures?.map((item) => item.rule),
        }),
      );
    }

    // Registry pricing applied to the tokens the providers actually reported.
    const byModel = new Map<string, { cost: number; input: number; output: number }>();
    for (const row of rows) {
      const bucket = byModel.get(row.model) ?? { cost: 0, input: 0, output: 0 };
      bucket.cost += row.costUsd;
      bucket.input += row.inputTokens;
      bucket.output += row.outputTokens;
      byModel.set(row.model, bucket);
    }
    console.log("\n=== cost by model (registry pricing x real usage) ===");
    for (const [model, bucket] of byModel) {
      console.log(
        `${model.padEnd(26)} in=${String(bucket.input).padStart(7)} out=${String(bucket.output).padStart(6)} cost=$${bucket.cost.toFixed(6)}`,
      );
    }

    ledger.applyCosts(rows);
    ledger.print();
    console.log(`\ntotal real cost this run: $${rows.reduce((sum, row) => sum + row.costUsd, 0).toFixed(6)}`);
  } finally {
    await db.delete(aiGenerations).where(eq(aiGenerations.tenantId, tenantId));
    await db.delete(aiModelPolicyOverrides).where(eq(aiModelPolicyOverrides.tenantId, tenantId));
    await db.delete(tenants).where(eq(tenants.id, tenantId));
    await redis.quit();
    await handle.close();
  }
}

async function setTierOverride(
  db: ReturnType<typeof makeDbHandle>["db"],
  policies: CachedModelPolicyStore,
  tenantId: string,
  tier: AITier,
): Promise<void> {
  await db
    .insert(aiModelPolicyOverrides)
    .values({
      id: randomUUID(),
      tenantId,
      task: "facebook_content",
      override: { primary: tier, maxEscalations: 0 },
      note: "ai-live-smoke",
    })
    .onConflictDoUpdate({
      target: [aiModelPolicyOverrides.tenantId, aiModelPolicyOverrides.task],
      set: { override: { primary: tier, maxEscalations: 0 } },
    });
  await policies.invalidate({ tenantId, task: "facebook_content" });
}

/**
 * Real, whitelisted sheet data. Fails loudly instead of inventing a product:
 * the point of this step is that the model saw the SHEET, not a fixture.
 */
async function loadRealProduct(
  db: ReturnType<typeof makeDbHandle>["db"],
): Promise<{ code: string; content: typeof SYNTHETIC_PRODUCT }> {
  const code = process.env.AI_LIVE_PRODUCT_CODE ?? "MGKVX6310";
  const [row] = await db
    .select({
      code: products.code,
      name: products.name,
      description: products.description,
      category: products.category,
      season: products.season,
    })
    .from(products)
    .where(eq(products.code, code))
    .limit(1);

  if (!row) {
    throw new Error(
      `Product ${code} is not in this database. Run scripts/catalog-smoke.ts against the same DATABASE_URL first.`,
    );
  }
  return {
    code: row.code,
    content: {
      name: row.name,
      description: row.description ?? "",
      category: row.category ?? "",
      season: row.season ?? "",
    },
  };
}

main().catch((error: unknown) => {
  // Pass the error itself: the pino adapter serialises AppError; a pre-flattened
  // toLogObject() would land in the "unknown value" branch and print [object Object].
  logger.error("AI LIVE SMOKE FAILED", { err: error });
  process.exitCode = 1;
});
