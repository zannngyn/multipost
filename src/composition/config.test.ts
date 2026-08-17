import { describe, expect, it } from "vitest";

import { AppError } from "@/core/domain/errors";

import {
  loadAiConfig,
  loadAuthConfig,
  loadConfig,
  loadGoogleConfig,
  loadMediaConfig,
  loadMetaOAuthConfig,
  loadSecretsConfig,
  type EnvRecord,
} from "./config";

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

describe("loadGoogleConfig — Service Account (E2)", () => {
  it("rejects an env with neither credential variable", () => {
    expect(issuePaths(catchError(() => loadGoogleConfig({})))).toEqual([
      "GOOGLE_SERVICE_ACCOUNT_JSON",
    ]);
  });

  it("rejects blank values (a defined-but-empty secret must not pass)", () => {
    expect(
      issuePaths(
        catchError(() =>
          loadGoogleConfig({ GOOGLE_SERVICE_ACCOUNT_JSON: "  ", GOOGLE_APPLICATION_CREDENTIALS: "" }),
        ),
      ),
    ).toEqual(["GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_SERVICE_ACCOUNT_JSON"]);
  });

  it("accepts the inlined key", () => {
    expect(loadGoogleConfig({ GOOGLE_SERVICE_ACCOUNT_JSON: '{"a":1}' })).toMatchObject({
      GOOGLE_SERVICE_ACCOUNT_JSON: '{"a":1}',
    });
  });

  it("accepts the key path alone", () => {
    expect(loadGoogleConfig({ GOOGLE_APPLICATION_CREDENTIALS: "./sa.json" })).toMatchObject({
      GOOGLE_APPLICATION_CREDENTIALS: "./sa.json",
    });
  });

  it("is not required by loadConfig — a worker boots without Google credentials", () => {
    expect(() => loadConfig(CORE_ENV)).not.toThrow();
  });
});

const OPENAI_ONLY_ENV = { OPENAI_API_KEY: "sk-openai" } satisfies EnvRecord;

describe("loadAiConfig — single provider (E4, owner decision 15/08/2026)", () => {
  it("accepts an env with OPENAI_API_KEY and no Google key at all", () => {
    const config = loadAiConfig({ OPENAI_API_KEY: "sk-openai" });

    expect(config).toMatchObject({
      OPENAI_API_KEY: "sk-openai",
      AI_MODELS_CONFIG_PATH: "./config/ai-models.yaml",
    });
    expect(config.GOOGLE_AI_API_KEY).toBeUndefined();
  });

  // `GOOGLE_AI_API_KEY=` is how a .env leaves an optional key out; it must read
  // as "provider disabled", not as a validation error — that exact line is what
  // used to stop the whole system from starting.
  it.each(["", "   "])("treats a blank Google key (%j) as disabled, not as an error", (blank) => {
    const config = loadAiConfig({ OPENAI_API_KEY: "sk-openai", GOOGLE_AI_API_KEY: blank });

    expect(config.GOOGLE_AI_API_KEY).toBeUndefined();
    expect(config.OPENAI_API_KEY).toBe("sk-openai");
  });

  it("trims a real key rather than passing surrounding whitespace to the SDK", () => {
    expect(
      loadAiConfig({ OPENAI_API_KEY: "sk-openai", GOOGLE_AI_API_KEY: "  AIza-paid  " })
        .GOOGLE_AI_API_KEY,
    ).toBe("AIza-paid");
  });

  it("requires OPENAI_API_KEY — without it nothing can be generated", () => {
    expect(issuePaths(catchError(() => loadAiConfig({})))).toEqual(["OPENAI_API_KEY"]);
  });

  it("leaves the tier model knobs undefined when nothing is set", () => {
    const config = loadAiConfig(OPENAI_ONLY_ENV);

    expect(config.AI_MODEL_CHEAP).toBeUndefined();
    expect(config.AI_MODEL_MID).toBeUndefined();
    expect(config.AI_MODEL_TOP).toBeUndefined();
  });

  it("passes a tier model through verbatim — the registry validates the key, not zod", () => {
    const config = loadAiConfig({
      ...OPENAI_ONLY_ENV,
      AI_MODEL_CHEAP: " openai:gpt-4o-mini ",
      AI_MODEL_TOP: "",
    });

    expect(config.AI_MODEL_CHEAP).toBe("openai:gpt-4o-mini");
    expect(config.AI_MODEL_TOP).toBeUndefined();
  });

  it("keeps the Google key when it IS set, so re-enabling needs no code change", () => {
    expect(
      loadAiConfig({ OPENAI_API_KEY: "sk-openai", GOOGLE_AI_API_KEY: "AIza-paid" }),
    ).toMatchObject({ GOOGLE_AI_API_KEY: "AIza-paid" });
  });
});

describe("loadMediaConfig / loadSecretsConfig (E3 hardening)", () => {
  const KEY_32_BYTES = Buffer.alloc(32, 7).toString("base64");

  it("neither group is required by loadConfig — a process boots without them", () => {
    expect(() => loadConfig(CORE_ENV)).not.toThrow();
  });

  const MEDIA_BASE = "https://media.example.com";

  it("rejects a missing or too short media signing secret", () => {
    expect(issuePaths(catchError(() => loadMediaConfig({}))).sort()).toEqual([
      "MEDIA_PUBLIC_BASE_URL",
      "MEDIA_SIGNING_SECRET",
    ]);
    expect(
      issuePaths(
        catchError(() =>
          loadMediaConfig({ MEDIA_SIGNING_SECRET: "short", MEDIA_PUBLIC_BASE_URL: MEDIA_BASE }),
        ),
      ),
    ).toEqual(["MEDIA_SIGNING_SECRET"]);
  });

  it("rejects a public base url that is not http(s)", () => {
    const secret = "0123456789012345678901234567890123456789";
    expect(
      issuePaths(
        catchError(() =>
          loadMediaConfig({ MEDIA_SIGNING_SECRET: secret, MEDIA_PUBLIC_BASE_URL: "ftp://x" }),
        ),
      ),
    ).toEqual(["MEDIA_PUBLIC_BASE_URL"]);
  });

  it("accepts a media signing secret of at least 32 chars", () => {
    const secret = "0123456789012345678901234567890123456789";
    expect(
      loadMediaConfig({ MEDIA_SIGNING_SECRET: secret, MEDIA_PUBLIC_BASE_URL: MEDIA_BASE }),
    ).toEqual({
      MEDIA_SIGNING_SECRET: secret,
      MEDIA_PUBLIC_BASE_URL: MEDIA_BASE,
    });
  });

  it.each([
    ["missing", {}],
    ["blank", { TENANT_SECRETS_ENC_KEY: "   " }],
    ["not base64", { TENANT_SECRETS_ENC_KEY: "nope!!!" }],
    ["16 bytes", { TENANT_SECRETS_ENC_KEY: Buffer.alloc(16).toString("base64") }],
    ["64 bytes", { TENANT_SECRETS_ENC_KEY: Buffer.alloc(64).toString("base64") }],
  ])("rejects an encryption key that is %s", (_label, env) => {
    expect(issuePaths(catchError(() => loadSecretsConfig(env)))).toEqual([
      "TENANT_SECRETS_ENC_KEY",
    ]);
  });

  it("accepts base64 of exactly 32 bytes", () => {
    expect(loadSecretsConfig({ TENANT_SECRETS_ENC_KEY: KEY_32_BYTES })).toEqual({
      TENANT_SECRETS_ENC_KEY: KEY_32_BYTES,
    });
  });

  it("never echoes the value back in the error (only the variable name)", () => {
    const error = catchError(() => loadSecretsConfig({ TENANT_SECRETS_ENC_KEY: "super-secret!!" }));
    expect(JSON.stringify(error)).not.toContain("super-secret!!");
  });
});

describe("loadMetaOAuthConfig — Facebook connect (E5.1)", () => {
  it("accepts a deployment with NO Meta app at all (pasting a token still works)", () => {
    expect(loadMetaOAuthConfig({})).toEqual({});
  });

  it("treats a BLANK variable as not set, not as an empty value", () => {
    // `META_APP_SECRET=` in a .env means "not yet", and must not fail a process
    // that never opens the OAuth door.
    expect(
      loadMetaOAuthConfig({ META_APP_ID: "1640548543911378", META_APP_SECRET: "  " }),
    ).toEqual({ META_APP_ID: "1640548543911378" });
  });

  it("refuses a redirect URI that is not an http(s) URL", () => {
    const error = catchError(() =>
      loadMetaOAuthConfig({ META_OAUTH_REDIRECT_URI: "/api/channels/callback" }),
    );
    expect(issuePaths(error)).toEqual(["META_OAUTH_REDIRECT_URI"]);
  });

  it("reads a fully configured app", () => {
    expect(
      loadMetaOAuthConfig({
        META_APP_ID: "1640548543911378",
        META_APP_SECRET: "app-secret",
        META_OAUTH_REDIRECT_URI: "https://mysp.example.com/api/channels/callback",
      }),
    ).toEqual({
      META_APP_ID: "1640548543911378",
      META_APP_SECRET: "app-secret",
      META_OAUTH_REDIRECT_URI: "https://mysp.example.com/api/channels/callback",
    });
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
