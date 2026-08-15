import { randomUUID } from "node:crypto";

import { makeRedisAiCache, type AiCache } from "@/adapters/ai/cache/redis-cache";
import { makeLoggerGenerationLog } from "@/adapters/ai/generation-log/logger-generation-log";
import { makeGoogleProviderAdapter } from "@/adapters/ai/google/google-provider";
import { makeOpenAIProviderAdapter } from "@/adapters/ai/openai/openai-provider";
import { makeDbPromptStore } from "@/adapters/ai/prompt-store/db-prompt-store";
import {
  BUILT_IN_TEMPLATES,
  makeStaticPromptStore,
} from "@/adapters/ai/prompt-store/static-prompt-store";
import { makeCachedModelPolicyStore } from "@/adapters/ai/registry-store/cached-model-policy-store";
import { makeYamlModelPolicyStore } from "@/adapters/ai/registry-store/yaml-model-policy-store";
import { DrizzleAiModelPolicyOverrideRepo } from "@/adapters/db/ai-model-policy-override-repo.drizzle";
import { makeDrizzleGenerationLog } from "@/adapters/db/ai-generation-log.drizzle";
import { DrizzleAiPromptTemplateRepo } from "@/adapters/db/ai-prompt-template-repo.drizzle";
import type { Database } from "@/adapters/db/client";
import { createRedisConnection } from "@/adapters/queue/redis-connection";
import { makeContentEngine } from "@/core/ai/content-engine";
import type {
  AIProviderAdapter,
  AIProviderName,
  GenerationLog,
  ModelPolicyStore,
  PromptStore,
} from "@/core/ports/ai";
import type { Clock, Logger } from "@/core/ports/infra";
import {
  makeGenerateCaptions,
  type GenerateCaptionsInput,
  type GenerateCaptionsResult,
} from "@/core/usecases/generate-captions";
import {
  makeManagePromptTemplates,
  type ManagePromptTemplates,
} from "@/core/usecases/manage-prompt-templates";

import { loadAiConfig, type AiConfig, type EnvRecord } from "./config";

export type GenerateCaptions = (input: GenerateCaptionsInput) => Promise<GenerateCaptionsResult>;

export interface AiWiringDeps {
  logger: Logger;
  clock: Clock;
  db: Database;
  /** REDIS_URL. Absent = no hot cache; the YAML in-memory TTL still applies. */
  redisUrl?: string;
  env?: EnvRecord;
}

/**
 * Redis client for the registry hot cache.
 *
 * Composition creates it because `adapters/ai` may not import `adapters/queue`
 * (one-way law, docs/07 §5) and must not grow a second connection policy of its
 * own. It is separate from the BullMQ connection on purpose: cache GET/SET must
 * not queue behind a blocking queue command.
 */
function makeAiCache(deps: AiWiringDeps): { cache: AiCache | undefined; close: () => Promise<void> } {
  if (!deps.redisUrl) {
    deps.logger.warn("AI registry hot cache disabled: no REDIS_URL provided", {
      component: "ai-engine",
    });
    return { cache: undefined, close: async () => {} };
  }

  const connection = createRedisConnection({
    url: deps.redisUrl,
    logger: deps.logger.child({ component: "ai-registry-cache" }),
  });
  return {
    cache: makeRedisAiCache(connection, deps.logger),
    close: async () => {
      await connection.quit();
    },
  };
}

export interface AiStores {
  policies: ModelPolicyStore;
  prompts: PromptStore;
  generationLog: GenerationLog;
  promptTemplates: ManagePromptTemplates;
  close: () => Promise<void>;
}

/**
 * All AI persistence in one place: registry (YAML + tenant override + Redis),
 * prompt catalog (DB + built-in fallback) and the `ai_generation` writer.
 */
export function makeAiStores(deps: AiWiringDeps): AiStores {
  const config = loadAiConfig(deps.env);
  const { cache, close } = makeAiCache(deps);

  const promptRepo = new DrizzleAiPromptTemplateRepo(deps.db, deps.logger);

  return {
    policies: makeCachedModelPolicyStore({
      base: makeYamlModelPolicyStore({
        filePath: config.AI_MODELS_CONFIG_PATH,
        clock: deps.clock,
        logger: deps.logger,
        ttlMs: config.AI_REGISTRY_CACHE_TTL_MS,
      }),
      overrides: new DrizzleAiModelPolicyOverrideRepo(deps.db, deps.logger),
      cache,
      logger: deps.logger,
      ttlMs: config.AI_REGISTRY_CACHE_TTL_MS,
    }),
    prompts: makeDbPromptStore({
      repo: promptRepo,
      builtIn: makeStaticPromptStore(),
      logger: deps.logger,
    }),
    generationLog: makeDrizzleGenerationLog({
      db: deps.db,
      logger: deps.logger,
      newId: () => randomUUID(),
    }),
    promptTemplates: makeManagePromptTemplates({
      templates: promptRepo,
      builtIn: BUILT_IN_TEMPLATES,
      logger: deps.logger,
      newId: () => randomUUID(),
    }),
    close,
  };
}

/**
 * Prompt-template administration (E10.7). Built lazily like the generation
 * path: only the DB is needed, no provider key, so an admin screen works on a
 * process that never generated anything.
 */
export function makeLazyPromptTemplates(deps: AiWiringDeps): ManagePromptTemplates {
  let cached: ManagePromptTemplates | null = null;
  const build = (): ManagePromptTemplates => {
    cached ??= makeManagePromptTemplates({
      templates: new DrizzleAiPromptTemplateRepo(deps.db, deps.logger),
      builtIn: BUILT_IN_TEMPLATES,
      logger: deps.logger,
      newId: () => randomUUID(),
    });
    return cached;
  };

  return {
    listVersions: (input) => build().listVersions(input),
    getActive: (input) => build().getActive(input),
    createVersion: (input) => build().createVersion(input),
    activateVersion: (input) => build().activateVersion(input),
  };
}

/**
 * Provider adapters actually wired for this process.
 *
 * OpenAI is the only provider guaranteed to be present (owner decision
 * 15/08/2026, single-provider mode). Google is wired only when a key exists, so
 * a deployment without GOOGLE_AI_API_KEY generates content instead of refusing
 * to start. The registry decides which of them is ever REACHED — a tier naming
 * an unwired provider still fails loudly in the engine, it is not silently
 * skipped.
 */
export function buildProviders(
  config: AiConfig,
  logger: Logger,
): Partial<Record<AIProviderName, AIProviderAdapter>> {
  const providers: Partial<Record<AIProviderName, AIProviderAdapter>> = {
    openai: makeOpenAIProviderAdapter({ apiKey: config.OPENAI_API_KEY, logger }),
  };

  if (config.GOOGLE_AI_API_KEY) {
    providers.google = makeGoogleProviderAdapter({
      apiKey: config.GOOGLE_AI_API_KEY,
      logger,
    });
  } else {
    logger.warn("Google AI provider not wired: GOOGLE_AI_API_KEY is unset", {
      component: "ai-engine",
      wired_providers: Object.keys(providers),
    });
  }

  return providers;
}

/**
 * Lazy AI wiring, same contract as `google-sources.ts`: provider keys, the
 * registry file and the Redis connection are touched on the FIRST generation
 * call, not at container build, so web/worker boot and `next build` succeed
 * without AI credentials. A missing key then fails the generation request with
 * the offending variable named.
 */
export function makeLazyGenerateCaptions(deps: AiWiringDeps): GenerateCaptions {
  let cached: GenerateCaptions | null = null;

  const build = (): GenerateCaptions => {
    if (cached) return cached;
    const config = loadAiConfig(deps.env);
    const stores = makeAiStores(deps);
    aiStoreClosers.add(stores.close);

    const contentEngine = makeContentEngine({
      providers: buildProviders(config, deps.logger),
      policies: stores.policies,
      prompts: stores.prompts,
      generationLog: stores.generationLog,
      logger: deps.logger,
      clock: deps.clock,
      ids: { newId: () => randomUUID() },
    });
    cached = makeGenerateCaptions({ contentEngine, logger: deps.logger });
    return cached;
  };

  return (input) => build()(input);
}

/** Redis connections opened lazily by the AI wiring, drained by closeContainer(). */
const aiStoreClosers = new Set<() => Promise<void>>();

export async function closeAiStores(): Promise<void> {
  const closers = [...aiStoreClosers];
  aiStoreClosers.clear();
  for (const close of closers) await close();
}

/** Log-only generation sink, for processes wired without a database. */
export { makeLoggerGenerationLog };
