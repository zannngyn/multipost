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

/**
 * Optional variable where `NAME=` (the usual way to leave a line in a .env
 * without setting it) must read as "not configured" rather than as an error.
 * Required values keep using {@link nonEmpty}, where blank IS a mistake.
 *
 * Not secret-specific on purpose: it is used for API keys and for plain model
 * names alike, and nothing here redacts anything.
 */
const optionalTrimmed = z
  .string()
  .optional()
  .transform((value) => {
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
  });

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
  /**
   * DOMAIN FILTER for Google sign-in — a NECESSARY condition, never a grant.
   *
   * A domain names an OPEN-ENDED set of people ("anyone with a company
   * address"), so it can say who may not sign in, but it must never hand out
   * access or the power to approve others: with `mysp.vn` here, every employee
   * would be an unblockable super-admin. Whoever passes this filter still has to
   * be approved in `access_request` like anyone else, and can still be blocked.
   * Individual grants live in AUTH_BOOTSTRAP_ADMINS / AUTH_FACEBOOK_ALLOWED_USER_IDS.
   *
   * BLANK/ABSENT = NO DOMAIN FILTER (changed 19/08/2026 — it used to mean "reject
   * everyone"). Both deploy env examples ship it blank, and the old meaning made
   * an approved Google operator unable to sign in on prod at all. It stays safe
   * because the registry is what grants access, and a new identity starts
   * `pending`: no filter is not an open door.
   */
  AUTH_ALLOWED_DOMAINS: blankAsUndefined(csvList),
  /**
   * THE escape hatch: comma-separated EXACT e-mail addresses (not domains) that
   * are always allowed in, always count as access admins, and cannot be blocked
   * from the screen. Keep it to the one or two people who must be able to fix a
   * broken registry — every other operator belongs in `access_request`.
   *
   * Exact addresses on purpose: this grants administrative power, so it must
   * name individuals, exactly as AUTH_FACEBOOK_ALLOWED_USER_IDS does.
   */
  AUTH_BOOTSTRAP_ADMINS: blankAsUndefined(csvList),
  /**
   * Comma-separated Facebook user ids with BOOTSTRAP ADMIN rights (E5.2) — the
   * Facebook half of AUTH_BOOTSTRAP_ADMINS, and already the right shape: it
   * names individuals, one id at a time. An absent list simply means no
   * Facebook bootstrap admin; other Facebook accounts can still sign in and
   * land in the registry as `pending`. Ids rather than e-mail addresses on
   * purpose: Facebook does not guarantee an e-mail (accounts registered with a
   * phone number have none), so the identity key is the pair (provider, id).
   *
   * Blank reads as absent, like the other optional values here: `NAME=` is how
   * a .env leaves a value unset — it is what .env.example ships and what
   * compose passes for an unset variable — and rejecting it took down the whole
   * sign-in page instead of just the Facebook button.
   */
  AUTH_FACEBOOK_ALLOWED_USER_IDS: blankAsUndefined(csvList),
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
 * Google Drive OAuth app (E2 — "Kết nối Google Drive"). Its own lazy group, and
 * ALL THREE ARE OPTIONAL on purpose:
 *   - a tenant that never connects keeps reading Drive through the Service
 *     Account, exactly as before, so `next build` and every existing deployment
 *     must boot without these;
 *   - pressing the button without them answers GOOGLE_OAUTH_NOT_CONFIGURED
 *     naming the missing variable, instead of a redirect into a Google 400.
 *
 * The client id/secret are the SAME OAuth client the operator sign-in uses
 * (`AuthConfigSchema`); only the redirect URI differs, so it gets its own
 * variable. Both redirect URIs must be registered in the Cloud Console client.
 */
export const GoogleOAuthConfigSchema = z.object({
  GOOGLE_CLIENT_ID: blankAsUndefined(z.string().trim().min(1)),
  GOOGLE_CLIENT_SECRET: blankAsUndefined(z.string().trim().min(1)),
  /** Must match an "Authorized redirect URI" of the OAuth client, exactly. */
  GOOGLE_OAUTH_REDIRECT_URI: blankAsUndefined(
    z
      .string()
      .trim()
      .min(1)
      .refine(
        (value) => value.startsWith("https://") || value.startsWith("http://"),
        "GOOGLE_OAUTH_REDIRECT_URI must be an http(s) URL",
      ),
  ),
});

export type GoogleOAuthConfig = z.infer<typeof GoogleOAuthConfigSchema>;

/**
 * AI gateway (E4, ADR-001). Loaded on demand like auth/google: processes that
 * never generate content must boot without provider keys. Path/TTL are
 * operational knobs with documented defaults, not secrets.
 *
 * Owner decision 15/08/2026: SINGLE PROVIDER — OpenAI only. Google stays in the
 * codebase (adapter, registry entries) but is off until a key is provisioned, so
 * its variable is optional and the tiers in `config/ai-models.yaml` list no
 * Google model. Re-enabling = set GOOGLE_AI_API_KEY + put the keys back in the
 * YAML tiers; no code change.
 */
export const AiConfigSchema = z.object({
  /**
   * Google AI Studio key. Optional while the Google provider is disabled. When
   * set it MUST be paid tier before real data flows (ADR-001) — the free tier
   * grants Google training rights over shop data.
   *
   * `GOOGLE_AI_API_KEY=` (the normal way to leave a key out of a .env) means
   * DISABLED, not "misconfigured": blank collapses to undefined so the caller
   * has exactly one shape to branch on. This is the opposite of the required
   * secrets above, where blank must fail — there, blank means someone deleted a
   * value that the system cannot run without.
   */
  GOOGLE_AI_API_KEY: optionalTrimmed,
  /** The only wired provider today; a generation without it cannot run. */
  OPENAI_API_KEY: nonEmpty("OPENAI_API_KEY"),
  AI_MODELS_CONFIG_PATH: z.string().trim().min(1).default("./config/ai-models.yaml"),
  AI_REGISTRY_CACHE_TTL_MS: z.coerce.number().int().positive().default(60_000),

  /**
   * Swap the model of one tier without editing the registry file — the knob for
   * "try another model in staging" and for an emergency swap in production.
   *
   * The value is a registry KEY ("openai:gpt-4.1-mini"), never a raw model
   * string: ADR-001 keeps every model string reviewable in
   * `config/ai-models.yaml`, and an unknown key fails at load naming the ones
   * that exist. To use a model that is not registered yet, add it to the YAML
   * first — that is the review step, not red tape.
   */
  AI_MODEL_CHEAP: optionalTrimmed,
  AI_MODEL_MID: optionalTrimmed,
  AI_MODEL_TOP: optionalTrimmed,
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
 * Facebook Login app credentials (E5.1 — "Kết nối Fanpage"). Its own lazy group:
 * publishing needs none of it, and `next build` must not require a Meta app.
 *
 * ALL THREE ARE OPTIONAL here, on purpose — a Meta app hands out a usable User
 * Access Token long before its App Secret is available, and the "paste a token"
 * door must work meanwhile:
 *   - paste a token : needs nothing (the token IS the credential). Without an
 *                     App Secret the token cannot be extended to 60 days, and
 *                     the adapter warns instead of failing.
 *   - OAuth         : needs all three. The adapter refuses with a message
 *                     naming the missing variables (adapters/meta/facebook-oauth).
 * Blank values are treated as absent: `META_APP_SECRET=` in a .env is "not set
 * yet", not "set to the empty string".
 */
export const MetaOAuthConfigSchema = z.object({
  META_APP_ID: blankAsUndefined(z.string().trim().min(1)),
  META_APP_SECRET: blankAsUndefined(z.string().trim().min(1)),
  /** Must match the redirect URI registered in the Meta app, exactly. */
  META_OAUTH_REDIRECT_URI: blankAsUndefined(
    z
      .string()
      .trim()
      .min(1)
      .refine(
        (value) => value.startsWith("https://") || value.startsWith("http://"),
        "META_OAUTH_REDIRECT_URI must be an http(s) URL",
      ),
  ),
});

export type MetaOAuthConfig = z.infer<typeof MetaOAuthConfigSchema>;

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

/**
 * Operator-uploaded media (E9, mode B). Its own group with a working default so
 * a dev box needs no setup; in Docker the path is a mounted volume, because the
 * bytes must outlive a container restart — the post that references them can be
 * scheduled for tomorrow.
 */
export const UploadConfigSchema = z.object({
  /** Directory the blob store writes under; one sub-directory per tenant. */
  UPLOAD_STORAGE_ROOT: z.string().trim().min(1).default("./var/uploads"),
  /**
   * How long an uploaded blob may stay unreferenced before the cleanup job may
   * remove it (E9.4). Generous on purpose: it is measured from the upload, and
   * an operator may leave a half-composed post open over a lunch break.
   */
  UPLOAD_ORPHAN_TTL_HOURS: z.coerce.number().int().positive().max(720).default(24),
});

export type UploadConfig = z.infer<typeof UploadConfigSchema>;

/**
 * Drive byte cache (E3.6 hardening). Its own lazy group with working defaults,
 * like the upload group: a dev box needs no setup, and in Docker the path is a
 * mounted volume shared by web (writes on a miss) and worker (sweeps).
 *
 * It exists because Graph API fetches every photo URL itself and gives up around
 * 30s, while Drive answered in 6.7s–99.9s per file on a real 10-photo post.
 */
export const MediaCacheConfigSchema = z.object({
  /** Directory the cache writes under; one sub-directory per tenant. */
  MEDIA_CACHE_ROOT: z.string().trim().min(1).default("./var/media-cache"),
  /**
   * How long a cached copy may be served before it is re-read from Drive. This
   * is the staleness budget of the whole feature: a file REPLACED on Drive under
   * the same id keeps serving its old bytes until the entry expires. 72h is a
   * compromise — long enough that a post re-published over a weekend still hits,
   * short enough that a mistake fixed on Drive reaches Facebook within days.
   */
  MEDIA_CACHE_TTL_HOURS: z.coerce.number().int().positive().max(720).default(72),
});

export type MediaCacheConfig = z.infer<typeof MediaCacheConfigSchema>;

export const SecretsConfigSchema = z.object({
  /** base64 of exactly 32 random bytes: `openssl rand -base64 32`. */
  TENANT_SECRETS_ENC_KEY: nonEmpty("TENANT_SECRETS_ENC_KEY").refine(
    (value) => decodesTo32Bytes(value),
    "TENANT_SECRETS_ENC_KEY must be base64 of exactly 32 bytes",
  ),
});

export type SecretsConfig = z.infer<typeof SecretsConfigSchema>;

/**
 * `KEY=` in a .env file is an EMPTY STRING, not an absent value. For an optional
 * variable that difference is noise: both mean "not configured yet", and failing
 * validation on the blank line would block a deployment that never uses it.
 */
function blankAsUndefined<T extends z.ZodType>(schema: T) {
  return z.preprocess(
    (value) => (typeof value === "string" && value.trim().length === 0 ? undefined : value),
    schema.optional(),
  );
}

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

export function loadGoogleOAuthConfig(env: EnvRecord = process.env): GoogleOAuthConfig {
  return parseEnv(GoogleOAuthConfigSchema, env, "google-oauth");
}

export function loadAiConfig(env: EnvRecord = process.env): AiConfig {
  return parseEnv(AiConfigSchema, env, "ai");
}

export function loadMetaConfig(env: EnvRecord = process.env): MetaConfig {
  return parseEnv(MetaConfigSchema, env, "meta");
}

export function loadMetaOAuthConfig(env: EnvRecord = process.env): MetaOAuthConfig {
  return parseEnv(MetaOAuthConfigSchema, env, "meta-oauth");
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

export function loadUploadConfig(env: EnvRecord = process.env): UploadConfig {
  return parseEnv(UploadConfigSchema, env, "upload");
}

export function loadMediaCacheConfig(env: EnvRecord = process.env): MediaCacheConfig {
  return parseEnv(MediaCacheConfigSchema, env, "media-cache");
}
