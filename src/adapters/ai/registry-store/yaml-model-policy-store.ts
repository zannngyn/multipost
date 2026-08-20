/**
 * ModelPolicyStore backed by `config/ai-models.yaml` (ADR-001 decision 12/08:
 * YAML-in-repo + per-tenant DB override, hot cache in Redis).
 *
 * This file owns the YAML half only: parse, validate, keep in memory for a
 * short TTL. The per-tenant `ai_model_policy_override` overlay and the Redis
 * hot cache wrap it in `cached-model-policy-store.ts`, so "what the file says"
 * and "what this tenant gets" never blur into one function.
 */

import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";

import { AppError } from "@/core/domain/errors";
import type {
  AITask,
  AITier,
  ModelEntry,
  ModelPolicyStore,
  ResolvedModelPolicy,
} from "@/core/ports/ai";
import type { Clock, Logger } from "@/core/ports/infra";
import {
  findRegistryInconsistencies,
  registrySchema,
  type RegistryFile,
} from "@/adapters/ai/registry-store/registry-schema";
import type { TenantId } from "@/core/domain/tenant-context";

export interface YamlModelPolicyStoreOptions {
  filePath: string;
  clock: Clock;
  logger: Logger;
  /** Short TTL: the file is re-read on change without restarting the worker. */
  ttlMs?: number;
  /**
   * Deployment-level tier swap from env (AI_MODEL_CHEAP/MID/TOP). Each value is
   * a registry KEY and REPLACES that tier's model list, so the chosen model is
   * both the primary and the only candidate for the tier.
   *
   * Deliberately narrower than the per-tenant DB override: this is one setting
   * for the whole process, applied before any tenant overlay, and it can only
   * name models the YAML already declares.
   */
  tierModels?: Partial<Record<AITier, string>>;
}

const DEFAULT_TTL_MS = 60_000;

export function makeYamlModelPolicyStore(options: YamlModelPolicyStoreOptions): ModelPolicyStore {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  let cached: { registry: RegistryFile; loadedAtMs: number } | null = null;
  // The swap is a stable deployment setting, so it is announced once. The TTL
  // reload happens every minute forever; warning there would bury the log.
  let overrideAnnounced = false;

  function load(): RegistryFile {
    const now = options.clock.nowMs();
    if (cached && now - cached.loadedAtMs < ttlMs) return cached.registry;

    const registry = applyTierModels(
      readRegistry(options.filePath, options.logger),
      options.tierModels,
      options.logger,
      { announce: !overrideAnnounced },
    );
    overrideAnnounced = true;
    cached = { registry, loadedAtMs: now };
    options.logger.info("AI model registry loaded", {
      file: options.filePath,
      registry_version: registry.version,
      models: Object.keys(registry.models).length,
      tiers: registry.tiers,
    });
    return registry;
  }

  return {
    async getPolicy({ tenantId, task }): Promise<ResolvedModelPolicy> {
      const registry = load();
      const policy = registry.tasks[task];

      if (!policy) {
        options.logger.error("No registry policy for task", {
          error_code: "MODEL_NOT_CONFIGURED",
          tenant_id: tenantId,
          task,
        });
        throw new AppError("MODEL_NOT_CONFIGURED", {
          message: `Registry has no policy for task "${task}"`,
          context: { tenant_id: tenantId, task, registry_version: registry.version },
        });
      }

      const tiers = resolveTiers(registry, tenantId, task);

      return {
        task,
        policy: {
          task,
          vision: policy.vision,
          primary: policy.primary,
          escalate: policy.escalate,
          maxEscalations: policy.maxEscalations,
          maxOutputTokens: policy.maxOutputTokens,
          timeoutMs: policy.timeoutMs,
          temperature: policy.temperature,
        },
        tiers,
        budget: registry.budget,
        registryVersion: registry.version,
      };
    },
  };
}

/**
 * Overlay the env tier swap on the parsed registry.
 *
 * Runs AFTER schema + consistency checks so it can only ever narrow a valid
 * registry, and validates its own input: an unknown key raises
 * MODEL_NOT_CONFIGURED listing every key it could have said.
 *
 * NOTE on when that happens: the registry is read lazily, on the first
 * `getPolicy` of the process — not at boot. A bad AI_MODEL_* therefore lets the
 * web and worker start, then fails every generation with the message above. That
 * is the same lifecycle as a missing provider key (composition/ai-engine.ts), so
 * a container does not crash-loop over a config value it may never need.
 */
function applyTierModels(
  registry: RegistryFile,
  tierModels: Partial<Record<AITier, string>> | undefined,
  logger: Logger,
  options: { announce: boolean },
): RegistryFile {
  if (!tierModels) return registry;

  const entries = (["cheap", "mid", "top"] as const)
    .map((tier) => [tier, tierModels[tier]?.trim()] as const)
    .filter((entry): entry is readonly [AITier, string] => Boolean(entry[1]));
  if (entries.length === 0) return registry;

  const tiers = { ...registry.tiers };

  for (const [tier, key] of entries) {
    if (!registry.models[key]) {
      const known = Object.keys(registry.models).sort();
      logger.error("Env tier override names a model that is not in the registry", {
        error_code: "MODEL_NOT_CONFIGURED",
        tier,
        model_key: key,
        known_models: known,
      });
      throw new AppError("MODEL_NOT_CONFIGURED", {
        message: `AI_MODEL_${tier.toUpperCase()} names "${key}", which is not declared in the registry. Known models: ${known.join(", ")}`,
        userMessage:
          "Cấu hình model AI trỏ tới model không có trong registry — cần quản trị viên sửa.",
        context: { tier, model_key: key, known_models: known },
      });
    }
    tiers[tier] = [key];
    if (options.announce) {
      logger.warn("AI tier model overridden by environment", {
        component: "ai-registry",
        tier,
        model_key: key,
      });
    }
  }

  return { ...registry, tiers };
}

function resolveTiers(
  registry: RegistryFile,
  tenantId: TenantId,
  task: AITask,
): Record<AITier, ModelEntry[]> {
  const resolved: Record<AITier, ModelEntry[]> = { cheap: [], mid: [], top: [] };

  for (const tier of ["cheap", "mid", "top"] as const) {
    const keys = registry.tiers[tier] ?? [];
    resolved[tier] = keys.map((key) => {
      const model = registry.models[key];
      // Guarded at load time; re-checked here so a future DB override cannot
      // introduce a dangling key silently.
      if (!model) {
        throw new AppError("MODEL_NOT_CONFIGURED", {
          message: `Registry tier "${tier}" references unknown model "${key}"`,
          context: { tenant_id: tenantId, task, tier, model_key: key },
        });
      }
      return {
        key,
        provider: model.provider,
        model: model.model,
        pricing: model.pricing,
        capabilities: model.capabilities,
      } satisfies ModelEntry;
    });
  }

  return resolved;
}

function readRegistry(filePath: string, logger: Logger): RegistryFile {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (error) {
    logger.error("Cannot read AI model registry file", {
      error_code: "MODEL_NOT_CONFIGURED",
      file: filePath,
      err: error,
    });
    throw new AppError("MODEL_NOT_CONFIGURED", {
      message: `Cannot read AI model registry at ${filePath}`,
      context: { file: filePath },
      cause: error,
    });
  }

  let document: unknown;
  try {
    document = parseYaml(raw);
  } catch (error) {
    logger.error("AI model registry is not valid YAML", {
      error_code: "MODEL_NOT_CONFIGURED",
      file: filePath,
      err: error,
    });
    throw new AppError("MODEL_NOT_CONFIGURED", {
      message: `AI model registry at ${filePath} is not valid YAML`,
      context: { file: filePath },
      cause: error,
    });
  }

  const parsed = registrySchema.safeParse(document);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => ({
      path: issue.path.join("."),
      code: issue.code,
      message: issue.message,
    }));
    logger.error("AI model registry failed schema validation", {
      error_code: "MODEL_NOT_CONFIGURED",
      file: filePath,
      issues,
    });
    throw new AppError("MODEL_NOT_CONFIGURED", {
      message: `AI model registry at ${filePath} failed schema validation`,
      context: { file: filePath, issues },
    });
  }

  const problems = findRegistryInconsistencies(parsed.data);
  if (problems.length > 0) {
    logger.error("AI model registry is internally inconsistent", {
      error_code: "MODEL_NOT_CONFIGURED",
      file: filePath,
      problems,
    });
    throw new AppError("MODEL_NOT_CONFIGURED", {
      message: `AI model registry at ${filePath} is inconsistent: ${problems.join("; ")}`,
      context: { file: filePath, problems },
    });
  }

  return parsed.data;
}
