import { describe, expect, it } from "vitest";

import { AppError } from "@/core/domain/errors";

import { loadWorkerConfig } from "../worker-container";

/**
 * Env is a boundary (CLAUDE.md #2): edge cases first. The worker must refuse to
 * boot on a bad env instead of running with guessed values.
 */

const validEnv = {
  NODE_ENV: "production",
  DATABASE_URL: "postgresql://mysp:mysp@postgres:5432/mysp",
  REDIS_URL: "redis://redis:6379",
};

function pathsOf(error: unknown): string[] {
  expect(AppError.is(error)).toBe(true);
  const issues = ((error as AppError).context as { issues?: Array<{ path: string }> }).issues ?? [];
  return issues.map((issue) => issue.path);
}

describe("loadWorkerConfig — invalid env", () => {
  it("rejects a missing NODE_ENV: there is no 'development' default", () => {
    const { NODE_ENV: _drop, ...env } = validEnv;
    try {
      loadWorkerConfig(env);
      throw new Error("expected loadWorkerConfig to throw");
    } catch (error) {
      expect((error as AppError).code).toBe("INVALID_INPUT");
      expect(pathsOf(error)).toContain("NODE_ENV");
    }
  });

  it("rejects a missing DATABASE_URL — the worker runs usecases that touch the DB", () => {
    const { DATABASE_URL: _drop, ...env } = validEnv;
    try {
      loadWorkerConfig(env);
      throw new Error("expected loadWorkerConfig to throw");
    } catch (error) {
      expect(pathsOf(error)).toContain("DATABASE_URL");
    }
  });

  it.each([
    ["a non-numeric concurrency", { WORKER_CONCURRENCY: "many" }],
    ["a zero concurrency", { WORKER_CONCURRENCY: "0" }],
    ["a concurrency above the cap", { WORKER_CONCURRENCY: "500" }],
    ["an empty heartbeat file", { WORKER_HEARTBEAT_FILE: "   " }],
    ["a too small heartbeat interval", { WORKER_HEARTBEAT_INTERVAL_MS: "10" }],
    ["a zero shutdown deadline", { WORKER_SHUTDOWN_DEADLINE_MS: "0" }],
  ])("rejects %s", (_label, override) => {
    expect(() => loadWorkerConfig({ ...validEnv, ...override })).toThrowError(AppError);
  });

  it("reports shared AND worker gaps in a single throw", () => {
    try {
      loadWorkerConfig({ REDIS_URL: "redis://redis:6379", WORKER_CONCURRENCY: "0" });
      throw new Error("expected loadWorkerConfig to throw");
    } catch (error) {
      const paths = pathsOf(error);
      // One restart per missing key is how a deploy burns an afternoon.
      expect(paths).toEqual(expect.arrayContaining(["NODE_ENV", "DATABASE_URL"]));
      expect(paths).toContain("WORKER_CONCURRENCY");
      expect((error as AppError).userMessage).toMatch(/Cấu hình worker/i);
    }
  });
});

describe("loadWorkerConfig — valid env", () => {
  it("merges the shared config with the worker defaults", () => {
    expect(loadWorkerConfig(validEnv)).toEqual({
      NODE_ENV: "production",
      LOG_LEVEL: "info",
      LOG_PRETTY: false,
      DATABASE_URL: validEnv.DATABASE_URL,
      REDIS_URL: validEnv.REDIS_URL,
      WORKER_CONCURRENCY: 5,
      WORKER_HEARTBEAT_FILE: "/tmp/mysp-worker-heartbeat",
      WORKER_HEARTBEAT_INTERVAL_MS: 15_000,
      WORKER_SHUTDOWN_DEADLINE_MS: 30_000,
    });
  });

  it("keeps explicit worker overrides", () => {
    const config = loadWorkerConfig({
      ...validEnv,
      LOG_LEVEL: "debug",
      LOG_PRETTY: "true",
      WORKER_CONCURRENCY: "1",
      WORKER_SHUTDOWN_DEADLINE_MS: "1",
    });
    expect(config).toMatchObject({
      LOG_LEVEL: "debug",
      LOG_PRETTY: true,
      WORKER_CONCURRENCY: 1,
      WORKER_SHUTDOWN_DEADLINE_MS: 1,
    });
  });
});
