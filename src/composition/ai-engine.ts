import { randomUUID } from "node:crypto";

import { makeLoggerGenerationLog } from "@/adapters/ai/generation-log/logger-generation-log";
import { makeGoogleProviderAdapter } from "@/adapters/ai/google/google-provider";
import { makeOpenAIProviderAdapter } from "@/adapters/ai/openai/openai-provider";
import { makeStaticPromptStore } from "@/adapters/ai/prompt-store/static-prompt-store";
import { makeYamlModelPolicyStore } from "@/adapters/ai/registry-store/yaml-model-policy-store";
import { makeContentEngine } from "@/core/ai/content-engine";
import type { Clock, Logger } from "@/core/ports/infra";
import {
  makeGenerateCaptions,
  type GenerateCaptionsInput,
  type GenerateCaptionsResult,
} from "@/core/usecases/generate-captions";

import { loadAiConfig, type EnvRecord } from "./config";

export type GenerateCaptions = (input: GenerateCaptionsInput) => Promise<GenerateCaptionsResult>;

/**
 * Lazy AI wiring, same contract as `google-sources.ts`: provider keys are read
 * on the FIRST generation call, not at container build, so web/worker boot and
 * `next build` succeed without AI credentials. A missing key then fails the
 * generation request with the offending variable named.
 */
export function makeLazyGenerateCaptions(deps: {
  logger: Logger;
  clock: Clock;
  env?: EnvRecord;
}): GenerateCaptions {
  let cached: GenerateCaptions | null = null;

  const build = (): GenerateCaptions => {
    if (cached) return cached;
    const config = loadAiConfig(deps.env);
    const contentEngine = makeContentEngine({
      providers: {
        google: makeGoogleProviderAdapter({ apiKey: config.GOOGLE_AI_API_KEY, logger: deps.logger }),
        openai: makeOpenAIProviderAdapter({ apiKey: config.OPENAI_API_KEY, logger: deps.logger }),
      },
      policies: makeYamlModelPolicyStore({
        filePath: config.AI_MODELS_CONFIG_PATH,
        clock: deps.clock,
        logger: deps.logger,
        ttlMs: config.AI_REGISTRY_CACHE_TTL_MS,
      }),
      prompts: makeStaticPromptStore(),
      generationLog: makeLoggerGenerationLog(deps.logger),
      logger: deps.logger,
      clock: deps.clock,
      ids: { newId: () => randomUUID() },
    });
    cached = makeGenerateCaptions({ contentEngine, logger: deps.logger });
    return cached;
  };

  return (input) => build()(input);
}
