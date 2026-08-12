import { z } from "zod";

import { AppError } from "@/core/domain/errors";

/**
 * Env config, validated once at process start. Missing/invalid values fail fast —
 * no silent defaults for anything that reaches an external system.
 */

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
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
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

  GOOGLE_CLIENT_ID: nonEmpty("GOOGLE_CLIENT_ID"),
  GOOGLE_CLIENT_SECRET: nonEmpty("GOOGLE_CLIENT_SECRET"),
  /** Comma-separated e-mail domains allowed to sign in. */
  AUTH_ALLOWED_DOMAINS: csvList,
  SESSION_SECRET: nonEmpty("SESSION_SECRET").min(32, "SESSION_SECRET must be at least 32 chars"),
});

export type Config = z.infer<typeof ConfigSchema>;

/**
 * Parse an env-like record. Throws AppError('INVALID_INPUT') listing every bad key —
 * one throw, not one per variable, so a fresh deploy reports all gaps at once.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = ConfigSchema.safeParse(env);
  if (parsed.success) return parsed.data;

  const issues = parsed.error.issues.map((issue) => ({
    path: issue.path.join(".") || "(root)",
    message: issue.message,
  }));

  throw new AppError("INVALID_INPUT", {
    message: `Invalid environment configuration: ${issues.map((i) => i.path).join(", ")}`,
    userMessage: "Cấu hình hệ thống chưa đầy đủ. Vui lòng liên hệ quản trị viên.",
    context: { issues },
  });
}
