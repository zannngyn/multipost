/**
 * The registry as ADR-001 defines it, assembled:
 *
 *   YAML in repo (reviewed in a PR)
 *     + ai_model_policy_override for this tenant (hot change, no deploy)
 *     + Redis cache with a short TTL (worker does not hit the DB per generation)
 *
 * Layering is deliberate: this store owns caching and merging only. Reading YAML
 * stays in `yaml-model-policy-store`, reading the override row stays in a repo
 * behind a core port, and what a merge MEANS stays in `core/ai/model-policy`.
 *
 * Failure policy: Redis down => cache miss (logged, generation continues).
 * A malformed override => MODEL_NOT_CONFIGURED, because quietly running the
 * default routing for a tenant who configured something else is worse than a
 * loud failure.
 */

import { applyPolicyOverride } from "@/core/ai/model-policy";
import { AppError } from "@/core/domain/errors";
import type {
  AITask,
  ModelPolicyOverrideRepo,
  ModelPolicyStore,
  ResolvedModelPolicy,
} from "@/core/ports/ai";
import type { Logger } from "@/core/ports/infra";
import type { AiCache } from "@/adapters/ai/cache/redis-cache";

/** Bump when the cached JSON shape changes — old entries then simply miss. */
const CACHE_NAMESPACE = "ai:policy:v1";
const DEFAULT_TTL_MS = 60_000;

export interface CachedModelPolicyStoreOptions {
  /** YAML-backed store: the reviewed default for every tenant. */
  base: ModelPolicyStore;
  /** Absent = this deployment runs YAML only (tests, scripts). */
  overrides?: ModelPolicyOverrideRepo;
  /** Absent = no hot cache; the in-memory TTL of the YAML store still applies. */
  cache?: AiCache;
  logger: Logger;
  ttlMs?: number;
}

export interface CacheStats {
  hits: number;
  misses: number;
  /** Cached payloads that failed to parse and were treated as a miss. */
  corrupt: number;
}

export interface CachedModelPolicyStore extends ModelPolicyStore {
  /** Call after writing an override row: TTL alone would keep stale routing. */
  invalidate(query: { tenantId: string; task?: AITask }): Promise<void>;
  /** Observability for smoke scripts and the admin dashboard. */
  stats(): CacheStats;
}

function cacheKey(tenantId: string, task: AITask): string {
  return `${CACHE_NAMESPACE}:${tenantId}:${task}`;
}

export function makeCachedModelPolicyStore(
  options: CachedModelPolicyStoreOptions,
): CachedModelPolicyStore {
  const ttlMs = options.ttlMs && options.ttlMs > 0 ? options.ttlMs : DEFAULT_TTL_MS;
  const stats: CacheStats = { hits: 0, misses: 0, corrupt: 0 };

  async function readCache(key: string, tenantId: string, task: AITask) {
    if (!options.cache) return null;
    const raw = await options.cache.get(key);
    if (!raw) return null;

    try {
      return JSON.parse(raw) as ResolvedModelPolicy;
    } catch (error) {
      // A corrupt entry must not poison every generation until the TTL expires.
      stats.corrupt += 1;
      options.logger.warn("Cached model policy is not valid JSON — dropping the entry", {
        error_code: "MODEL_NOT_CONFIGURED",
        tenant_id: tenantId,
        task,
        cache_key: key,
        err: AppError.from(error, "INTERNAL", { cache_key: key }),
      });
      await options.cache.invalidate({ key }).catch(() => undefined);
      return null;
    }
  }

  return {
    async getPolicy({ tenantId, task }): Promise<ResolvedModelPolicy> {
      // --- Edge cases first --------------------------------------------------
      const tenant = typeof tenantId === "string" ? tenantId.trim() : "";
      if (!tenant) {
        throw new AppError("INVALID_INPUT", {
          message: "getPolicy requires a tenantId",
          userMessage: "Thiếu mã đơn vị (tenant) khi tra cấu hình model.",
          context: { task: task ?? null },
        });
      }

      const key = cacheKey(tenant, task);
      const cached = await readCache(key, tenant, task);
      if (cached) {
        stats.hits += 1;
        options.logger.debug("Model policy cache hit", {
          tenant_id: tenant,
          task,
          cache_key: key,
          tier: cached.policy?.primary,
        });
        return cached;
      }

      stats.misses += 1;
      const base = await options.base.getPolicy({ tenantId: tenant, task });

      const record = options.overrides
        ? await options.overrides.findOverride({ tenantId: tenant, task })
        : null;

      const resolved = record
        ? applyPolicyOverride(base, record.override, { tenantId: tenant })
        : base;

      if (record) {
        options.logger.info("Tenant model policy override applied", {
          tenant_id: tenant,
          task,
          override_keys: Object.keys(record.override),
          primary_tier: resolved.policy.primary,
          registry_version: resolved.registryVersion,
        });
      }

      if (options.cache) {
        await options.cache.set(key, JSON.stringify(resolved), ttlMs);
        options.logger.debug("Model policy cached", {
          tenant_id: tenant,
          task,
          cache_key: key,
          ttl_ms: ttlMs,
        });
      }

      return resolved;
    },

    async invalidate({ tenantId, task }) {
      if (!options.cache) return;
      const tenant = typeof tenantId === "string" ? tenantId.trim() : "";
      if (!tenant) {
        throw new AppError("INVALID_INPUT", {
          message: "invalidate requires a tenantId",
          userMessage: "Thiếu mã đơn vị (tenant) khi làm mới cấu hình model.",
        });
      }

      await options.cache.invalidate(
        task
          ? { key: cacheKey(tenant, task) }
          : { pattern: `${CACHE_NAMESPACE}:${tenant}:*` },
      );
      options.logger.info("Model policy cache invalidated", {
        tenant_id: tenant,
        task: task ?? null,
      });
    },

    stats() {
      return { ...stats };
    },
  };
}
