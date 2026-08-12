/**
 * ModelPolicyStore backed by `config/ai-models.yaml` (ADR-001 decision 12/08:
 * YAML-in-repo + per-tenant DB override, hot cache in Redis).
 *
 * Shipped in this sprint: the YAML half + an in-memory TTL cache.
 * TODO(ADR-001, sprint tích hợp): layer the `ai_model_policy_override` table on
 * top per tenant and move the hot cache into Redis with invalidation on change
 * (docs/ai/model-routing.md §2). The port signature already carries `tenantId`
 * so neither addition changes a caller.
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

export interface YamlModelPolicyStoreOptions {
  filePath: string;
  clock: Clock;
  logger: Logger;
  /** Short TTL: the file is re-read on change without restarting the worker. */
  ttlMs?: number;
}

const DEFAULT_TTL_MS = 60_000;

export function makeYamlModelPolicyStore(options: YamlModelPolicyStoreOptions): ModelPolicyStore {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  let cached: { registry: RegistryFile; loadedAtMs: number } | null = null;

  function load(): RegistryFile {
    const now = options.clock.nowMs();
    if (cached && now - cached.loadedAtMs < ttlMs) return cached.registry;

    const registry = readRegistry(options.filePath, options.logger);
    cached = { registry, loadedAtMs: now };
    options.logger.info("AI model registry loaded", {
      file: options.filePath,
      registry_version: registry.version,
      models: Object.keys(registry.models).length,
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

function resolveTiers(
  registry: RegistryFile,
  tenantId: string,
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
