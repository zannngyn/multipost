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
