/**
 * Redis-backed hot cache for the merged model registry (ADR-001: "bản registry
 * đã merge được cache nóng trong Redis với TTL ngắn").
 *
 * Zone note: this file does NOT open a connection. `adapters/ai` may not import
 * `adapters/queue` (one-way law, docs/07 §5 — adapters talk through core, never
 * to each other), and opening a second ioredis client here would duplicate the
 * connection policy that already lives in the queue adapter. So composition —
 * the only layer allowed to know both — creates the connection and injects it.
 * The interface below is structural, so an ioredis client satisfies it as-is
 * and a fake satisfies it in tests.
 */

import { AppError } from "@/core/domain/errors";
import type { Logger } from "@/core/ports/infra";

/** The three commands this cache needs; ioredis `Redis` structurally matches. */
export interface RedisLikeClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: "PX", ttlMs: number): Promise<unknown>;
  del(...keys: string[]): Promise<unknown>;
  keys(pattern: string): Promise<string[]>;
}

export interface AiCache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlMs: number): Promise<void>;
  /** Deletes exact keys and/or a `prefix*` pattern. */
  invalidate(input: { key?: string; pattern?: string }): Promise<void>;
}

/**
 * Every method degrades to "cache miss" on a Redis failure: the registry is
 * still readable from YAML + DB, and losing Redis must not stop content
 * generation. The failure is logged with its context every time — it is
 * degraded, not silent.
 */
export function makeRedisAiCache(client: RedisLikeClient, logger: Logger): AiCache {
  const log = logger.child({ component: "ai-registry-cache" });

  return {
    async get(key) {
      try {
        return await client.get(key);
      } catch (error) {
        log.warn("Registry cache read failed — falling back to source", {
          error_code: "QUEUE_ERROR",
          cache_key: key,
          err: AppError.from(error, "QUEUE_ERROR", { cache_key: key }),
        });
        return null;
      }
    },

    async set(key, value, ttlMs) {
      try {
        await client.set(key, value, "PX", Math.max(1, Math.floor(ttlMs)));
      } catch (error) {
        log.warn("Registry cache write failed — value still served from source", {
          error_code: "QUEUE_ERROR",
          cache_key: key,
          ttl_ms: ttlMs,
          err: AppError.from(error, "QUEUE_ERROR", { cache_key: key }),
        });
      }
    },

    async invalidate({ key, pattern }) {
      try {
        if (key) await client.del(key);
        if (pattern) {
          // Tenant-scoped pattern over a handful of keys (tasks per tenant);
          // KEYS is acceptable at this cardinality and runs only on a config
          // change, never on the generation path.
          const keys = await client.keys(pattern);
          if (keys.length > 0) await client.del(...keys);
        }
      } catch (error) {
        // Rethrown: an invalidation that silently fails leaves stale routing in
        // place for up to the TTL, and the caller asked for it explicitly.
        const appError = AppError.from(error, "QUEUE_ERROR", { cache_key: key, pattern });
        log.error("Registry cache invalidation failed", {
          error_code: appError.code,
          cache_key: key ?? null,
          pattern: pattern ?? null,
          err: appError,
        });
        throw appError;
      }
    },
  };
}
