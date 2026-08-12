import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";

import { AppError } from "@/core/domain/errors";
import type { Logger } from "@/core/ports/infra";

/**
 * Envelope encryption for the credentials that live inside
 * `tenant_integration.config` (Page access tokens today, TikTok tokens later).
 *
 * Why here and not a new column: the config blob is jsonb and provider-shaped;
 * a per-provider secret column would need a migration for every new provider.
 * The envelope is a STRING inside the same jsonb, so nothing about the schema
 * changes — a sealed value simply looks like `enc:v1:<iv>:<tag>:<ciphertext>`.
 *
 * Migration path: `openSecret` accepts a value WITHOUT the prefix and returns it
 * unchanged with a warning. That is how the rows written before this box keep
 * working while an operator re-saves them; the warning is what makes the
 * remaining plaintext rows visible instead of silently permanent.
 *
 * Non-goals: this is not a KMS. The key sits in TENANT_SECRETS_ENC_KEY, so it
 * protects against a leaked database dump/backup, not against a leaked host.
 */

export const SECRET_ENVELOPE_PREFIX = "enc:v1:";
const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
/** Domain separation: a ciphertext from another feature will not open here. */
const AAD = Buffer.from("mysp:tenant_integration.config:v1", "utf8");

export interface SecretBox {
  /** Plaintext -> `enc:v1:...`. Throws on an empty or already-sealed value. */
  sealSecret(plain: string): string;
  /** `enc:v1:...` -> plaintext. Legacy plaintext passes through with a warning. */
  openSecret(stored: string, context?: SecretFieldContext): string;
}

/** Only for logs. Never carries the value itself. */
export interface SecretFieldContext {
  readonly tenantId?: string;
  readonly provider?: string;
  readonly field?: string;
}

export interface SecretBoxDeps {
  logger: Logger;
  /**
   * Returns the base64 key. A callback, not a value: a process that never
   * touches a secret must boot without TENANT_SECRETS_ENC_KEY, and the failure
   * then names the variable at the call site (technical rule 2).
   */
  readKey: () => string | undefined;
}

export function makeSecretBox(deps: SecretBoxDeps): SecretBox {
  let cachedKey: Buffer | null = null;

  const key = (): Buffer => {
    if (cachedKey) return cachedKey;
    cachedKey = parseKey(deps.readKey);
    return cachedKey;
  };

  return {
    sealSecret(plain: string): string {
      // --- Edge cases first --------------------------------------------------
      if (typeof plain !== "string" || plain.length === 0) {
        throw secretError("EMPTY_SECRET", "sealSecret requires a non-empty string");
      }
      if (isSealedSecret(plain)) {
        // Double sealing is always a bug: the caller lost track of the state and
        // the next reader would get an envelope back instead of a token.
        throw secretError("ALREADY_SEALED", "sealSecret received an already sealed value");
      }

      const iv = randomBytes(IV_BYTES);
      try {
        const cipher = createCipheriv(ALGORITHM, key(), iv, { authTagLength: TAG_BYTES });
        cipher.setAAD(AAD);
        const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
        const tag = cipher.getAuthTag();
        return [
          SECRET_ENVELOPE_PREFIX + iv.toString("base64"),
          tag.toString("base64"),
          ciphertext.toString("base64"),
        ].join(":");
      } catch (error) {
        // AppError.from would copy the driver message; that is safe here (no key
        // material in an OpenSSL message) and keeps the cause for debugging.
        throw AppError.from(error, "INVALID_INPUT", {
          scope: "secrets",
          reason: "ENCRYPT_FAILED",
        });
      }
    },

    openSecret(stored: string, context: SecretFieldContext = {}): string {
      // --- Edge cases first --------------------------------------------------
      if (typeof stored !== "string" || stored.length === 0) {
        throw secretError("EMPTY_SECRET", "openSecret requires a non-empty string", context);
      }

      if (!isSealedSecret(stored)) {
        // Legacy row: readable, but it must not stay invisible.
        deps.logger.warn("Read an UNENCRYPTED secret from tenant_integration.config", {
          scope: "secrets",
          reason: "PLAINTEXT_LEGACY",
          tenant_id: context.tenantId ?? null,
          provider: context.provider ?? null,
          field: context.field ?? null,
        });
        return stored;
      }

      const parts = stored.slice(SECRET_ENVELOPE_PREFIX.length).split(":");
      if (parts.length !== 3) {
        throw secretError("MALFORMED_ENVELOPE", "Sealed secret has an unexpected shape", context);
      }

      const iv = decodeBase64(parts[0]);
      const tag = decodeBase64(parts[1]);
      const ciphertext = decodeBase64(parts[2]);
      if (!iv || !tag || !ciphertext || iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
        throw secretError("MALFORMED_ENVELOPE", "Sealed secret has an unusable iv/tag", context);
      }

      try {
        const decipher = createDecipheriv(ALGORITHM, key(), iv, { authTagLength: TAG_BYTES });
        decipher.setAAD(AAD);
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
      } catch (error) {
        // Wrong key or tampered ciphertext — indistinguishable by design.
        throw AppError.from(error, "INVALID_INPUT", {
          scope: "secrets",
          reason: "DECRYPT_FAILED",
          tenant_id: context.tenantId ?? null,
          provider: context.provider ?? null,
          field: context.field ?? null,
        });
      }
    },
  };
}

export function isSealedSecret(value: unknown): boolean {
  return typeof value === "string" && value.startsWith(SECRET_ENVELOPE_PREFIX);
}

/**
 * Contract with every repo writing `tenant_integration.config`: a field whose
 * NAME looks like a credential must be sealed on write and opened on read.
 * Name-based on purpose — a new provider adding `refreshToken` is covered
 * without touching this file.
 */
const SECRET_FIELD_PATTERN = /(token|secret|password|passwd|credential|api[_-]?key|private[_-]?key)/i;

export function isSecretFieldName(name: unknown): boolean {
  return typeof name === "string" && SECRET_FIELD_PATTERN.test(name);
}

/** Depth cap: config blobs are shallow; a cycle must not hang a request. */
const MAX_DEPTH = 4;

/**
 * Seals every secret-looking string field of a config blob. Values that are
 * already sealed are left alone, so re-saving a config is idempotent.
 */
export function sealConfigSecrets<T>(config: T, box: SecretBox): T {
  return mapSecretFields(config, box, "seal", {}, 0) as T;
}

/** Opens every secret-looking string field. Plaintext legacy values pass through. */
export function openConfigSecrets<T>(config: T, box: SecretBox, context: SecretFieldContext = {}): T {
  return mapSecretFields(config, box, "open", context, 0) as T;
}

/**
 * Secret-looking fields stored WITHOUT the envelope. Repos log this so an
 * operator can see which rows still need a re-save (never the values).
 *
 * Walks arrays as well as objects — `channels[]` is where the Page tokens
 * actually live, so a scanner that only descended into objects reported "no
 * plaintext" on precisely the blob that had it. Array entries are reported with
 * an index: `channels[0].accessToken`.
 */
export function findPlaintextSecretFields(config: unknown, prefix = "", depth = 0): string[] {
  if (depth > MAX_DEPTH) return [];

  if (Array.isArray(config)) {
    return config.flatMap((item, index) =>
      findPlaintextSecretFields(item, `${prefix}[${index}]`, depth + 1),
    );
  }
  if (!isPlainRecord(config)) return [];

  const found: string[] = [];
  for (const [rawKey, value] of Object.entries(config)) {
    const path = prefix ? `${prefix}.${rawKey}` : rawKey;
    if (typeof value === "string") {
      if (isSecretFieldName(rawKey) && value.length > 0 && !isSealedSecret(value)) found.push(path);
      continue;
    }
    found.push(...findPlaintextSecretFields(value, path, depth + 1));
  }
  return found;
}

/** Constant-time equality for two secrets. Exported for tests/callers. */
export function secretsEqual(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

// --- helpers ----------------------------------------------------------------

function mapSecretFields(
  value: unknown,
  box: SecretBox,
  mode: "seal" | "open",
  context: SecretFieldContext,
  depth: number,
): unknown {
  if (depth > MAX_DEPTH) return value;
  if (Array.isArray(value)) {
    return value.map((item) => mapSecretFields(item, box, mode, context, depth + 1));
  }
  if (!isPlainRecord(value)) return value;

  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === "string" && isSecretFieldName(key) && child.length > 0) {
      if (mode === "seal") {
        result[key] = isSealedSecret(child) ? child : box.sealSecret(child);
      } else {
        result[key] = box.openSecret(child, { ...context, field: key });
      }
      continue;
    }
    result[key] = mapSecretFields(child, box, mode, context, depth + 1);
  }
  return result;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseKey(readKey: () => string | undefined): Buffer {
  let raw: string | undefined;
  try {
    raw = readKey();
  } catch (error) {
    throw AppError.from(error, "INVALID_INPUT", { scope: "secrets", reason: "KEY_UNREADABLE" });
  }

  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw secretError("KEY_MISSING", "TENANT_SECRETS_ENC_KEY is missing");
  }

  const key = decodeBase64(raw.trim());
  if (!key || key.length !== KEY_BYTES) {
    // Length only — the value never reaches a log or an error context.
    throw secretError(
      "KEY_LENGTH",
      `TENANT_SECRETS_ENC_KEY must decode to ${KEY_BYTES} bytes (base64), got ${key ? key.length : "invalid base64"}`,
    );
  }
  return key;
}

function decodeBase64(value: string | undefined): Buffer | null {
  if (typeof value !== "string" || value.length === 0) return null;
  // Node accepts both alphabets and ignores junk, so re-encoding is the check.
  const buffer = Buffer.from(value, "base64");
  if (buffer.length === 0) return null;
  const canonical = buffer.toString("base64");
  const normalised = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalised.padEnd(normalised.length + ((4 - (normalised.length % 4)) % 4), "=");
  return canonical === padded ? buffer : null;
}

const USER_MESSAGE = "Cấu hình mã hoá bí mật của hệ thống chưa đúng. Vui lòng liên hệ quản trị viên.";

function secretError(
  reason: string,
  message: string,
  context: SecretFieldContext = {},
): AppError {
  return new AppError("INVALID_INPUT", {
    message,
    userMessage: USER_MESSAGE,
    context: {
      scope: "secrets",
      reason,
      tenant_id: context.tenantId ?? null,
      provider: context.provider ?? null,
      field: context.field ?? null,
    },
  });
}
