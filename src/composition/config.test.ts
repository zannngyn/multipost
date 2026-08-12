import { describe, expect, it } from "vitest";

import { AppError } from "@/core/domain/errors";

import { loadAuthConfig, loadConfig, type EnvRecord } from "./config";

const CORE_ENV = {
  NODE_ENV: "test",
  DATABASE_URL: "postgres://mysp:mysp@localhost:5432/mysp",
  REDIS_URL: "redis://localhost:6379",
} satisfies EnvRecord;

const AUTH_ENV = {
  GOOGLE_CLIENT_ID: "client-id",
  GOOGLE_CLIENT_SECRET: "client-secret",
  AUTH_ALLOWED_DOMAINS: "Example.com, partner.vn ,",
  SESSION_SECRET: "0123456789012345678901234567890123456789",
} satisfies EnvRecord;

/**
 * Reads the variable names AppError flagged, deduped + sorted so tests assert on
 * WHICH variables are wrong, not on how many rules each one broke.
 */
function issuePaths(error: unknown): string[] {
  expect(AppError.is(error)).toBe(true);
  const issues = (error as AppError).context.issues as Array<{ path: string }>;
  return [...new Set(issues.map((issue) => issue.path))].sort();
}

describe("loadConfig — edge cases", () => {
  it("fails with INVALID_INPUT listing EVERY missing variable at once", () => {
    const error = (() => {
      try {
        loadConfig({});
        return null;
      } catch (e: unknown) {
        return e;
      }
    })();

    expect((error as AppError).code).toBe("INVALID_INPUT");
    expect(issuePaths(error)).toEqual(["DATABASE_URL", "NODE_ENV", "REDIS_URL"]);
    // The message must name the gaps: a deploy log is all an operator gets.
    expect((error as AppError).message).toContain("DATABASE_URL");
    expect((error as AppError).message).toContain("REDIS_URL");
    expect((error as AppError).context).toMatchObject({ scope: "core" });
  });

  it("requires NODE_ENV — no default, an unset value is a misconfigured runner", () => {
    const { NODE_ENV: _drop, ...rest } = CORE_ENV;

    expect(() => loadConfig(rest)).toThrowError(AppError);
    expect(issuePaths(catchError(() => loadConfig(rest)))).toEqual(["NODE_ENV"]);
  });

  it("rejects an unknown NODE_ENV value such as 'staging'", () => {
    expect(issuePaths(catchError(() => loadConfig({ ...CORE_ENV, NODE_ENV: "staging" })))).toEqual([
      "NODE_ENV",
    ]);
  });

  it.each([
    ["empty DATABASE_URL", { DATABASE_URL: "  " }],
    ["mysql DATABASE_URL", { DATABASE_URL: "mysql://localhost/mysp" }],
  ])("rejects %s", (_label, override) => {
    expect(issuePaths(catchError(() => loadConfig({ ...CORE_ENV, ...override })))).toEqual([
      "DATABASE_URL",
    ]);
  });

  it("rejects a REDIS_URL with the wrong scheme", () => {
    expect(
      issuePaths(catchError(() => loadConfig({ ...CORE_ENV, REDIS_URL: "http://localhost:6379" }))),
    ).toEqual(["REDIS_URL"]);
  });

  it("rejects an unknown LOG_LEVEL instead of falling back to info", () => {
    expect(issuePaths(catchError(() => loadConfig({ ...CORE_ENV, LOG_LEVEL: "verbose" })))).toEqual([
      "LOG_LEVEL",
    ]);
  });

  it("does NOT require auth variables — a worker boots without Google credentials", () => {
    expect(() => loadConfig(CORE_ENV)).not.toThrow();
  });
});

describe("loadConfig — happy path", () => {
  it("parses the core env and applies log defaults", () => {
    expect(loadConfig(CORE_ENV)).toEqual({
      NODE_ENV: "test",
      LOG_LEVEL: "info",
      LOG_PRETTY: false,
      DATABASE_URL: CORE_ENV.DATABASE_URL,
      REDIS_URL: CORE_ENV.REDIS_URL,
    });
  });

  it("turns LOG_PRETTY into a boolean", () => {
    expect(loadConfig({ ...CORE_ENV, LOG_PRETTY: "true" }).LOG_PRETTY).toBe(true);
    expect(loadConfig({ ...CORE_ENV, LOG_PRETTY: "false" }).LOG_PRETTY).toBe(false);
  });

  it("ignores unrelated env keys", () => {
    expect(loadConfig({ ...CORE_ENV, SOME_OTHER_TOOL: "x" }).NODE_ENV).toBe("test");
  });
});

describe("loadAuthConfig", () => {
  it("fails with INVALID_INPUT listing every missing auth variable", () => {
    const error = catchError(() => loadAuthConfig({}));

    expect((error as AppError).code).toBe("INVALID_INPUT");
    expect(issuePaths(error)).toEqual([
      "AUTH_ALLOWED_DOMAINS",
      "GOOGLE_CLIENT_ID",
      "GOOGLE_CLIENT_SECRET",
      "SESSION_SECRET",
    ]);
    expect((error as AppError).context).toMatchObject({ scope: "auth" });
  });

  it("rejects a SESSION_SECRET shorter than 32 chars", () => {
    expect(issuePaths(catchError(() => loadAuthConfig({ ...AUTH_ENV, SESSION_SECRET: "short" })))).toEqual(
      ["SESSION_SECRET"],
    );
  });

  it("rejects AUTH_ALLOWED_DOMAINS that is only separators", () => {
    expect(
      issuePaths(catchError(() => loadAuthConfig({ ...AUTH_ENV, AUTH_ALLOWED_DOMAINS: " , , " }))),
    ).toEqual(["AUTH_ALLOWED_DOMAINS"]);
  });

  it("parses AUTH_ALLOWED_DOMAINS csv into a lower-cased, trimmed array", () => {
    expect(loadAuthConfig(AUTH_ENV).AUTH_ALLOWED_DOMAINS).toEqual(["example.com", "partner.vn"]);
  });
});

/** Returns the thrown value; fails the test if nothing was thrown. */
function catchError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error: unknown) {
    return error;
  }
  throw new Error("expected the call to throw, but it returned normally");
}
