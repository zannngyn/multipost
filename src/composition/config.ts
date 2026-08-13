import { z } from "zod";

import { AppError } from "@/core/domain/errors";

/**
 * Env config, validated once at process start. Missing/invalid values fail fast —
 * no silent defaults for anything that reaches an external system.
 *
 * Split by concern: `loadConfig()` holds what EVERY process needs (runtime +
 * datastores); `loadAuthConfig()` holds sign-in secrets and is called only by
 * the auth epic, so a worker container does not need Google credentials to boot.
 */

/** Loose env shape: `process.env` fits, and tests can pass partial objects. */
export type EnvRecord = Record<string, string | undefined>;

const nonEmpty = (label: string) => z.string().trim().min(1, `${label} must not be empty`);

const csvList = z
  .string()
  .trim()
  .min(1)
  .transform((value) =>
    value
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter((item) => item.length > 0),
  )
  .refine((list) => list.length > 0, "must contain at least one entry");

export const ConfigSchema = z.object({
  // No default: an unset NODE_ENV means the process was started outside its
  // intended runner, and guessing "development" in production is how prod ends
  // up with dev logging/behaviour.
  NODE_ENV: z.enum(["development", "test", "production"]),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
  LOG_PRETTY: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),

  DATABASE_URL: nonEmpty("DATABASE_URL").refine(
    (value) => value.startsWith("postgres://") || value.startsWith("postgresql://"),
    "DATABASE_URL must be a postgres connection string",
  ),
  REDIS_URL: nonEmpty("REDIS_URL").refine(
    (value) => value.startsWith("redis://") || value.startsWith("rediss://"),
    "REDIS_URL must be a redis connection string",
  ),
});

export type Config = z.infer<typeof ConfigSchema>;

/** Operator sign-in. Loaded on demand by the auth epic, not at container build. */
export const AuthConfigSchema = z.object({
  GOOGLE_CLIENT_ID: nonEmpty("GOOGLE_CLIENT_ID"),
  GOOGLE_CLIENT_SECRET: nonEmpty("GOOGLE_CLIENT_SECRET"),
  /** Comma-separated e-mail domains allowed to sign in. */
  AUTH_ALLOWED_DOMAINS: csvList,
  SESSION_SECRET: nonEmpty("SESSION_SECRET").min(32, "SESSION_SECRET must be at least 32 chars"),
});

export type AuthConfig = z.infer<typeof AuthConfigSchema>;

/**
 * Service Account for Drive + Sheets (E2). Loaded on demand, like auth: the web
 * process can boot and serve pages without it, and the sync fails with a clear
 * message instead of the whole container refusing to start.
 *
 * Exactly one of the two variables is needed:
 *   GOOGLE_SERVICE_ACCOUNT_JSON    — key file inlined (container/secret)
 *   GOOGLE_APPLICATION_CREDENTIALS — path to the key file (local dev)
 */
export const GoogleConfigSchema = z
  .object({
    GOOGLE_SERVICE_ACCOUNT_JSON: z.string().trim().min(1).optional(),
    GOOGLE_APPLICATION_CREDENTIALS: z.string().trim().min(1).optional(),
  })
  .refine(
    (value) =>
      Boolean(value.GOOGLE_SERVICE_ACCOUNT_JSON) || Boolean(value.GOOGLE_APPLICATION_CREDENTIALS),
    {
      message:
        "Set GOOGLE_SERVICE_ACCOUNT_JSON or GOOGLE_APPLICATION_CREDENTIALS to reach Drive/Sheets",
      path: ["GOOGLE_SERVICE_ACCOUNT_JSON"],
    },
  );

export type GoogleConfig = z.infer<typeof GoogleConfigSchema>;

/**
 * AI gateway (E4, ADR-001). Loaded on demand like auth/google: processes that
 * never generate content must boot without provider keys. Path/TTL are
 * operational knobs with documented defaults, not secrets.
 */
export const AiConfigSchema = z.object({
  /** Google AI Studio key — MUST be paid tier before real data flows (ADR-001). */
  GOOGLE_AI_API_KEY: nonEmpty("GOOGLE_AI_API_KEY"),
  /** Infrastructure fallback provider. */
  OPENAI_API_KEY: nonEmpty("OPENAI_API_KEY"),
  AI_MODELS_CONFIG_PATH: z.string().trim().min(1).default("./config/ai-models.yaml"),
  AI_REGISTRY_CACHE_TTL_MS: z.coerce.number().int().positive().default(60_000),
});

export type AiConfig = z.infer<typeof AiConfigSchema>;

/**
 * Facebook publishing (E5). Loaded on demand like auth/google/ai: a process
 * that never publishes must boot without it.
 *
 * Only the API VERSION lives here — it is a deploy-time decision, identical for
 * every tenant. Page ids, Page tokens and the posting spacing stay in
 * `tenant_integration` (business rule 7); putting them in env would break
 * multi-tenancy on the first second tenant.
 */
export const MetaConfigSchema = z.object({
  META_GRAPH_VERSION: z
    .string()
    .trim()
    .regex(/^v\d+\.\d+$/, "META_GRAPH_VERSION must look like v23.0")
    .default("v23.0"),
});

export type MetaConfig = z.infer<typeof MetaConfigSchema>;

/**
 * Cryptographic material (E3/E5 hardening). Its own group, loaded on demand, so
 * a process that neither serves media nor reads a channel token still boots —
 * and a missing key fails at the call site naming the variable, not at startup.
 *
 * MEDIA_SIGNING_SECRET   — HMAC key of the signed media URL Facebook fetches
 *                          (adapters/crypto/media-signer). Rotating it
 *                          invalidates links already handed to Meta.
 * TENANT_SECRETS_ENC_KEY — AES-256-GCM key sealing the credentials inside
 *                          tenant_integration.config (adapters/db/secret-box).
 *                          Rotating it makes every sealed value unreadable, so
 *                          re-save the configs first.
 */
export const MediaConfigSchema = z.object({
  MEDIA_SIGNING_SECRET: nonEmpty("MEDIA_SIGNING_SECRET").min(
    32,
    "MEDIA_SIGNING_SECRET must be at least 32 chars",
  ),
  /** Public origin Meta fetches signed media URLs from (e.g. https://mysp.example.com). */
  MEDIA_PUBLIC_BASE_URL: nonEmpty("MEDIA_PUBLIC_BASE_URL").refine(
    (value) => value.startsWith("https://") || value.startsWith("http://"),
    "MEDIA_PUBLIC_BASE_URL must be an http(s) origin",
  ),
});

export type MediaConfig = z.infer<typeof MediaConfigSchema>;

/**
 * Video spec check (E3, Phase 2). Its own group with working defaults: the
 * binary normally comes from the worker image's PATH, so no deployment has to
 * set anything — but a host with ffprobe somewhere unusual can point at it.
 */
export const VideoConfigSchema = z.object({
  /** Binary path or bare name resolved through PATH. */
  FFPROBE_PATH: z.string().trim().min(1).default("ffprobe"),
  /** Hard stop for a hung ffprobe. */
  VIDEO_PROBE_TIMEOUT_MS: z.coerce.number().int().positive().max(120_000).default(15_000),
});

export type VideoConfig = z.infer<typeof VideoConfigSchema>;

export const SecretsConfigSchema = z.object({
  /** base64 of exactly 32 random bytes: `openssl rand -base64 32`. */
  TENANT_SECRETS_ENC_KEY: nonEmpty("TENANT_SECRETS_ENC_KEY").refine(
    (value) => decodesTo32Bytes(value),
    "TENANT_SECRETS_ENC_KEY must be base64 of exactly 32 bytes",
  ),
});

export type SecretsConfig = z.infer<typeof SecretsConfigSchema>;

/**
 * Length check without importing node:crypto: base64 of 32 bytes is 44 chars
 * ending in one '='. The box re-validates by decoding — this only turns an
 * obvious typo into a message naming the variable.
 */
function decodesTo32Bytes(value: string): boolean {
  const normalised = value.trim().replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  return /^[A-Za-z0-9+/]{43}$/.test(normalised);
}

/**
 * One throw listing every bad key — a fresh deploy reports all gaps at once
 * instead of one restart per missing variable.
 */
function parseEnv<T extends z.ZodType>(schema: T, env: EnvRecord, scope: string): z.infer<T> {
  const parsed = schema.safeParse(env);
  if (parsed.success) return parsed.data;

  const issues = parsed.error.issues.map((issue) => ({
    path: issue.path.join(".") || "(root)",
    message: issue.message,
  }));

  throw new AppError("INVALID_INPUT", {
    message: `Invalid ${scope} environment configuration: ${issues.map((i) => i.path).join(", ")}`,
    userMessage: "Cấu hình hệ thống chưa đầy đủ. Vui lòng liên hệ quản trị viên.",
    context: { scope, issues },
  });
}

export function loadConfig(env: EnvRecord = process.env): Config {
  return parseEnv(ConfigSchema, env, "core");
}

export function loadAuthConfig(env: EnvRecord = process.env): AuthConfig {
  return parseEnv(AuthConfigSchema, env, "auth");
}

export function loadGoogleConfig(env: EnvRecord = process.env): GoogleConfig {
  return parseEnv(GoogleConfigSchema, env, "google");
}

export function loadAiConfig(env: EnvRecord = process.env): AiConfig {
  return parseEnv(AiConfigSchema, env, "ai");
}

export function loadMetaConfig(env: EnvRecord = process.env): MetaConfig {
  return parseEnv(MetaConfigSchema, env, "meta");
}

export function loadMediaConfig(env: EnvRecord = process.env): MediaConfig {
  return parseEnv(MediaConfigSchema, env, "media");
}

export function loadSecretsConfig(env: EnvRecord = process.env): SecretsConfig {
  return parseEnv(SecretsConfigSchema, env, "secrets");
}

export function loadVideoConfig(env: EnvRecord = process.env): VideoConfig {
  return parseEnv(VideoConfigSchema, env, "video");
}
