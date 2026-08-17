import { describe, expect, it, vi } from "vitest";

import { waitingProgress, workingProgress } from "@/core/domain/post-job-progress";
import type { LogBindings, LogContext, Logger } from "@/core/ports/infra";

import {
  PROGRESS_TTL_SECONDS,
  makeRedisJobProgressStore,
  progressKey,
  type ProgressRedisClient,
} from "./redis-job-progress";

/**
 * The store is decoration (design §3.1): every test below asks the same
 * question in a different way — "does a broken store break anything?".
 */

const TENANT = "00000000-0000-0000-0000-000000000001";
const NOW = new Date("2026-08-17T09:00:00.000Z");

interface LogLine {
  level: string;
  message: string;
  context?: LogContext;
}

function recordingLogger(lines: LogLine[]): Logger {
  const make = (): Logger => ({
    child: (_bindings: LogBindings) => make(),
    debug: (message, context) => lines.push({ level: "debug", message, context }),
    info: (message, context) => lines.push({ level: "info", message, context }),
    warn: (message, context) => lines.push({ level: "warn", message, context }),
    error: (message, context) => lines.push({ level: "error", message, context }),
  });
  return make();
}

/** In-memory stand-in for the three commands the store uses. */
function fakeRedis(seed: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(seed));
  const client = {
    store,
    setCalls: [] as Array<{ key: string; value: string; ttl: number }>,
    delCalls: [] as string[],
    set: vi.fn(async (key: string, value: string, _mode: "EX", seconds: number) => {
      client.setCalls.push({ key, value, ttl: seconds });
      store.set(key, value);
      return "OK";
    }),
    mget: vi.fn(async (...keys: string[]) => keys.map((key) => store.get(key) ?? null)),
    del: vi.fn(async (...keys: string[]) => {
      client.delCalls.push(...keys);
      let removed = 0;
      for (const key of keys) if (store.delete(key)) removed += 1;
      return removed;
    }),
  };
  return client;
}

function makeStore(client: ProgressRedisClient) {
  const lines: LogLine[] = [];
  const store = makeRedisJobProgressStore({ connection: client, logger: recordingLogger(lines) });
  return { store, lines };
}

const UPLOADING = workingProgress("uploading_media", {
  attempt: 1,
  now: NOW,
  doneCount: 3,
  totalCount: 10,
  currentItem: "IMG_2041.jpg",
});

// --- Edge cases first -------------------------------------------------------

describe("read — values Redis should never have contained", () => {
  it("drops a key whose value is not JSON, keeps the other keys, and warns", async () => {
    const client = fakeRedis({
      [progressKey(TENANT, "job-broken")]: "{not json",
    });
    const { store, lines } = makeStore(client);
    await store.report({ tenantId: TENANT, postJobId: "job-ok", progress: UPLOADING });

    const map = await store.read(TENANT, ["job-broken", "job-ok"]);

    expect(map.has("job-broken")).toBe(false);
    expect(map.get("job-ok")?.stage).toBe("uploading_media");
    const warn = lines.find((line) => line.level === "warn");
    expect(warn?.context).toMatchObject({
      reason: "PROGRESS_JSON_BROKEN",
      tenant_id: TENANT,
      post_job_id: "job-broken",
    });
  });

  it("drops a key with a missing field instead of filling in a default", async () => {
    const client = fakeRedis({
      // No `attempt`, no `updated_at`.
      [progressKey(TENANT, "job-partial")]: JSON.stringify({
        v: 1,
        stage: "checking_stock",
        done_count: null,
        total_count: null,
        current_item: null,
        stage_started_at: NOW.toISOString(),
        wait_until: null,
      }),
    });
    const { store, lines } = makeStore(client);
    await store.report({ tenantId: TENANT, postJobId: "job-ok", progress: UPLOADING });

    const map = await store.read(TENANT, ["job-partial", "job-ok"]);

    expect(map.has("job-partial")).toBe(false);
    expect(map.has("job-ok")).toBe(true);
    expect(
      lines.some((line) => line.context?.reason === "PROGRESS_SCHEMA_INVALID"),
    ).toBe(true);
  });

  it("drops a key whose stage this build does not know", async () => {
    const client = fakeRedis({
      [progressKey(TENANT, "job-future")]: JSON.stringify({
        v: 1,
        stage: "teleporting_to_facebook",
        attempt: 1,
        done_count: null,
        total_count: null,
        current_item: null,
        stage_started_at: NOW.toISOString(),
        wait_until: null,
        updated_at: NOW.toISOString(),
      }),
    });
    const { store } = makeStore(client);

    const map = await store.read(TENANT, ["job-future"]);

    expect(map.size).toBe(0);
  });

  it("drops a key with an unreadable timestamp", async () => {
    const client = fakeRedis({
      [progressKey(TENANT, "job-time")]: JSON.stringify({
        v: 1,
        stage: "checking_stock",
        attempt: 1,
        done_count: null,
        total_count: null,
        current_item: null,
        stage_started_at: "hôm qua",
        wait_until: null,
        updated_at: NOW.toISOString(),
      }),
    });
    const { store, lines } = makeStore(client);

    const map = await store.read(TENANT, ["job-time"]);

    expect(map.size).toBe(0);
    expect(lines.some((line) => line.context?.reason === "PROGRESS_TIMESTAMP_INVALID")).toBe(true);
  });

  it("keeps the entry but drops the countdown when wait_until is unreadable (§3.2)", async () => {
    const client = fakeRedis({
      [progressKey(TENANT, "job-wait")]: JSON.stringify({
        v: 1,
        stage: "waiting_for_spacing",
        attempt: 1,
        done_count: null,
        total_count: null,
        current_item: null,
        stage_started_at: NOW.toISOString(),
        wait_until: "trong ít phút nữa",
        updated_at: NOW.toISOString(),
      }),
    });
    const { store } = makeStore(client);

    const map = await store.read(TENANT, ["job-wait"]);

    expect(map.get("job-wait")?.stage).toBe("waiting_for_spacing");
    expect(map.get("job-wait")?.waitUntil).toBeNull();
  });
});

describe("a store that is down", () => {
  const dead: ProgressRedisClient = {
    set: async () => {
      throw new Error("ECONNREFUSED 127.0.0.1:6379");
    },
    mget: async () => {
      throw new Error("ECONNREFUSED 127.0.0.1:6379");
    },
    del: async () => {
      throw new Error("ECONNREFUSED 127.0.0.1:6379");
    },
  };

  it("report does not throw, and says so in the log with full context", async () => {
    const { store, lines } = makeStore(dead);

    await expect(
      store.report({ tenantId: TENANT, postJobId: "job-1", progress: UPLOADING }),
    ).resolves.toBeUndefined();

    const warn = lines.find((line) => line.level === "warn");
    expect(warn?.context).toMatchObject({
      tenant_id: TENANT,
      post_job_id: "job-1",
      stage: "uploading_media",
      error_code: "QUEUE_ERROR",
    });
    expect(warn?.context?.err).toBeDefined();
  });

  it("read answers with an empty map instead of throwing", async () => {
    const { store, lines } = makeStore(dead);

    const map = await store.read(TENANT, ["job-1", "job-2"]);

    expect(map.size).toBe(0);
    expect(lines.some((line) => line.level === "warn")).toBe(true);
  });

  it("clear does not throw", async () => {
    const { store } = makeStore(dead);

    await expect(store.clear(TENANT, "job-1")).resolves.toBeUndefined();
  });
});

describe("identity guards", () => {
  it("never writes a key for a blank tenant or job id", async () => {
    const client = fakeRedis();
    const { store, lines } = makeStore(client);

    await store.report({ tenantId: "  ", postJobId: "job-1", progress: UPLOADING });
    await store.report({ tenantId: TENANT, postJobId: "", progress: UPLOADING });
    await store.clear("", "job-1");

    expect(client.set).not.toHaveBeenCalled();
    expect(client.del).not.toHaveBeenCalled();
    expect(lines.filter((line) => line.level === "warn")).toHaveLength(3);
  });

  it("does not call MGET for an empty id list (Redis refuses a keyless MGET)", async () => {
    const client = fakeRedis();
    const { store } = makeStore(client);

    const map = await store.read(TENANT, []);

    expect(map.size).toBe(0);
    expect(client.mget).not.toHaveBeenCalled();
  });
});

// --- Happy path -------------------------------------------------------------

describe("report / read / clear", () => {
  it("round-trips a progress with its counts, file name and TTL", async () => {
    const client = fakeRedis();
    const { store } = makeStore(client);

    await store.report({ tenantId: TENANT, postJobId: "job-1", progress: UPLOADING });

    expect(client.setCalls).toHaveLength(1);
    expect(client.setCalls[0].key).toBe(`mysp:progress:${TENANT}:job-1`);
    expect(client.setCalls[0].ttl).toBe(PROGRESS_TTL_SECONDS);

    const map = await store.read(TENANT, ["job-1"]);
    const stored = map.get("job-1");
    expect(stored).toEqual({
      stage: "uploading_media",
      attempt: 1,
      doneCount: 3,
      totalCount: 10,
      currentItem: "IMG_2041.jpg",
      stageStartedAt: NOW,
      waitUntil: null,
      updatedAt: NOW,
    });
  });

  it("round-trips the deadline of a waiting stage", async () => {
    const client = fakeRedis();
    const { store } = makeStore(client);
    const waitUntil = new Date(NOW.getTime() + 90_000);

    await store.report({
      tenantId: TENANT,
      postJobId: "job-1",
      progress: waitingProgress("waiting_for_spacing", { attempt: 2, waitUntil, now: NOW }),
    });

    const map = await store.read(TENANT, ["job-1"]);
    expect(map.get("job-1")?.waitUntil).toEqual(waitUntil);
    expect(map.get("job-1")?.attempt).toBe(2);
  });

  it("reads a whole batch in ONE round trip and skips the jobs with no entry", async () => {
    const client = fakeRedis();
    const { store } = makeStore(client);
    await store.report({ tenantId: TENANT, postJobId: "job-1", progress: UPLOADING });

    const map = await store.read(TENANT, ["job-1", "job-2", "job-3"]);

    expect(client.mget).toHaveBeenCalledTimes(1);
    expect([...map.keys()]).toEqual(["job-1"]);
  });

  it("keeps tenants apart", async () => {
    const client = fakeRedis();
    const { store } = makeStore(client);
    const other = "00000000-0000-0000-0000-000000000002";
    await store.report({ tenantId: TENANT, postJobId: "job-1", progress: UPLOADING });

    expect((await store.read(other, ["job-1"])).size).toBe(0);
  });

  it("clear removes the key so a finished job stops reporting progress", async () => {
    const client = fakeRedis();
    const { store } = makeStore(client);
    await store.report({ tenantId: TENANT, postJobId: "job-1", progress: UPLOADING });

    await store.clear(TENANT, "job-1");

    expect(client.delCalls).toEqual([`mysp:progress:${TENANT}:job-1`]);
    expect((await store.read(TENANT, ["job-1"])).size).toBe(0);
  });
});
