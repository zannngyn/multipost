import { describe, expect, it } from "vitest";

import { makeCachedModelPolicyStore } from "@/adapters/ai/registry-store/cached-model-policy-store";
import { makeRedisAiCache, type AiCache } from "@/adapters/ai/cache/redis-cache";
import { makeFakeLogger, makeTestPolicy } from "@/core/ai/testing";
import { AppError } from "@/core/domain/errors";
import type { ModelPolicyOverrideRepo, ModelPolicyStore } from "@/core/ports/ai";

const TENANT = "33333333-3333-3333-3333-333333333333";
const TASK = "facebook_content" as const;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function countingBase(): ModelPolicyStore & { calls: number } {
  const state = {
    calls: 0,
    async getPolicy() {
      state.calls += 1;
      return makeTestPolicy();
    },
  };
  return state;
}

function memoryCache(): AiCache & { store: Map<string, string>; reads: number; writes: number } {
  const state = {
    store: new Map<string, string>(),
    reads: 0,
    writes: 0,
    async get(key: string) {
      state.reads += 1;
      return state.store.get(key) ?? null;
    },
    async set(key: string, value: string) {
      state.writes += 1;
      state.store.set(key, value);
    },
    async invalidate({ key, pattern }: { key?: string; pattern?: string }) {
      if (key) state.store.delete(key);
      if (pattern) {
        // Redis KEYS globs anywhere in the string, not just at the end — the
        // real store now relies on that (`ai:policy:v1:*:tenant:*`).
        const matcher = new RegExp(
          `^${pattern.split("*").map(escapeRegExp).join(".*")}$`,
          "u",
        );
        for (const existing of [...state.store.keys()]) {
          if (matcher.test(existing)) state.store.delete(existing);
        }
      }
    },
  };
  return state;
}

function overrideRepo(
  override: Record<string, unknown>,
): ModelPolicyOverrideRepo & { calls: number } {
  const state = {
    calls: 0,
    async findOverride({ tenantId, task }: { tenantId: string; task: typeof TASK }) {
      state.calls += 1;
      return {
        tenantId,
        task,
        override,
        note: null,
        updatedAt: "2026-08-13T02:00:00.000Z",
      };
    },
  };
  return state;
}

describe("cached model policy store — edge cases", () => {
  it("rejects an empty tenantId instead of caching under a blank key", async () => {
    const store = makeCachedModelPolicyStore({ base: countingBase(), logger: makeFakeLogger() });
    await expect(store.getPolicy({ tenantId: "  ", task: TASK })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  });

  it("treats a corrupt cache entry as a miss and drops it", async () => {
    const base = countingBase();
    const cache = memoryCache();
    const store = makeCachedModelPolicyStore({ base, cache, logger: makeFakeLogger() });

    cache.store.set(`ai:policy:v1:default:${TENANT}:${TASK}`, "{not json");
    const policy = await store.getPolicy({ tenantId: TENANT, task: TASK });

    expect(policy.task).toBe(TASK);
    expect(base.calls).toBe(1);
    expect(store.stats().corrupt).toBe(1);
  });

  it("keeps serving policies when Redis is down (the cache adapter degrades to a miss)", async () => {
    const base = countingBase();
    const logger = makeFakeLogger();
    // The REAL cache adapter over a dead client: this is the production path of
    // a Redis outage, not a hand-written stub of it.
    const cache = makeRedisAiCache(
      {
        get: async () => {
          throw new Error("redis down");
        },
        set: async () => {
          throw new Error("redis down");
        },
        del: async () => {
          throw new Error("redis down");
        },
        keys: async () => {
          throw new Error("redis down");
        },
      },
      logger,
    );
    const store = makeCachedModelPolicyStore({ base, cache, logger });

    const policy = await store.getPolicy({ tenantId: TENANT, task: TASK });
    expect(policy.registryVersion).toBe(1);
    expect(base.calls).toBe(1);
    expect(logger.entries.some((entry) => entry.level === "warn")).toBe(true);
  });

  it("propagates a malformed override instead of silently using YAML defaults", async () => {
    const store = makeCachedModelPolicyStore({
      base: countingBase(),
      overrides: overrideRepo({ tierModels: { cheap: ["google:not-in-registry"] } }),
      logger: makeFakeLogger(),
    });

    await expect(store.getPolicy({ tenantId: TENANT, task: TASK })).rejects.toMatchObject({
      code: "MODEL_NOT_CONFIGURED",
    });
  });
});

describe("cached model policy store — caching", () => {
  it("serves the second call from Redis without touching YAML or the DB", async () => {
    const base = countingBase();
    const overrides = overrideRepo({ primary: "mid" });
    const cache = memoryCache();
    const store = makeCachedModelPolicyStore({
      base,
      overrides,
      cache,
      logger: makeFakeLogger(),
      ttlMs: 60_000,
    });

    const first = await store.getPolicy({ tenantId: TENANT, task: TASK });
    const second = await store.getPolicy({ tenantId: TENANT, task: TASK });

    expect(first.policy.primary).toBe("mid");
    expect(second.policy.primary).toBe("mid");
    expect(base.calls).toBe(1);
    expect(overrides.calls).toBe(1);
    expect(store.stats()).toEqual({ hits: 1, misses: 1, corrupt: 0 });
  });

  it("invalidation forces the next call back to the source", async () => {
    const base = countingBase();
    const cache = memoryCache();
    const store = makeCachedModelPolicyStore({ base, cache, logger: makeFakeLogger() });

    await store.getPolicy({ tenantId: TENANT, task: TASK });
    await store.invalidate({ tenantId: TENANT });
    await store.getPolicy({ tenantId: TENANT, task: TASK });

    expect(base.calls).toBe(2);
    expect(store.stats().hits).toBe(0);
  });

  it("caches per tenant — one tenant's override cannot leak to another", async () => {
    const base = countingBase();
    const cache = memoryCache();
    const store = makeCachedModelPolicyStore({
      base,
      overrides: overrideRepo({ maxOutputTokens: 123 }),
      cache,
      logger: makeFakeLogger(),
    });

    await store.getPolicy({ tenantId: TENANT, task: TASK });
    await store.getPolicy({ tenantId: "44444444-4444-4444-4444-444444444444", task: TASK });

    expect(cache.store.size).toBe(2);
    expect(base.calls).toBe(2);
  });

  /**
   * Measured on 15/08/2026 before `variant` existed: a dev server started with
   * a deliberately INVALID AI_MODEL_MID served captions happily, because it read
   * the resolved policy another process had cached — so neither the swap nor its
   * load-time validation ever ran. Web and worker share one Redis, so this is a
   * production shape, not a test-only curiosity.
   */
  it("does not let one process's tier swap leak into another's cache", async () => {
    const cache = memoryCache();
    const shared = { cache, logger: makeFakeLogger() };
    const withSwap = countingBase();
    const withoutSwap = countingBase();

    const swapped = makeCachedModelPolicyStore({
      ...shared,
      base: withSwap,
      variant: "cheap=openai:gpt-4.1",
    });
    const plain = makeCachedModelPolicyStore({ ...shared, base: withoutSwap });

    await swapped.getPolicy({ tenantId: TENANT, task: TASK });
    await plain.getPolicy({ tenantId: TENANT, task: TASK });

    // Two entries, and each store consulted its OWN base rather than reusing
    // the other's answer.
    expect(cache.store.size).toBe(2);
    expect(withSwap.calls).toBe(1);
    expect(withoutSwap.calls).toBe(1);
    expect([...cache.store.keys()].sort()).toEqual([
      `ai:policy:v1:cheap=openai:gpt-4.1:${TENANT}:${TASK}`,
      `ai:policy:v1:default:${TENANT}:${TASK}`,
    ]);
  });

  it("invalidating a tenant clears EVERY variant, not just the caller's", async () => {
    const cache = memoryCache();
    const shared = { cache, logger: makeFakeLogger() };
    const swapped = makeCachedModelPolicyStore({
      ...shared,
      base: countingBase(),
      variant: "top=openai:gpt-5",
    });
    const plain = makeCachedModelPolicyStore({ ...shared, base: countingBase() });

    await swapped.getPolicy({ tenantId: TENANT, task: TASK });
    await plain.getPolicy({ tenantId: TENANT, task: TASK });
    expect(cache.store.size).toBe(2);

    await plain.invalidate({ tenantId: TENANT });

    expect(cache.store.size).toBe(0);
  });

  it("invalidating one task leaves the other tasks of that tenant alone", async () => {
    const cache = memoryCache();
    const store = makeCachedModelPolicyStore({
      base: countingBase(),
      cache,
      logger: makeFakeLogger(),
    });

    await store.getPolicy({ tenantId: TENANT, task: TASK });
    await store.getPolicy({ tenantId: TENANT, task: "difficult_content" });
    await store.invalidate({ tenantId: TENANT, task: TASK });

    expect([...cache.store.keys()]).toEqual([
      `ai:policy:v1:default:${TENANT}:difficult_content`,
    ]);
  });

  it("an AppError from the base store is not cached", async () => {
    const cache = memoryCache();
    const failing: ModelPolicyStore = {
      async getPolicy() {
        throw new AppError("MODEL_NOT_CONFIGURED", { message: "no policy" });
      },
    };
    const store = makeCachedModelPolicyStore({ base: failing, cache, logger: makeFakeLogger() });

    await expect(store.getPolicy({ tenantId: TENANT, task: TASK })).rejects.toMatchObject({
      code: "MODEL_NOT_CONFIGURED",
    });
    expect(cache.store.size).toBe(0);
  });
});
