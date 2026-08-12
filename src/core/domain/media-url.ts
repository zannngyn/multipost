/**
 * Signed media URL — the bridge between a Drive file only the Service Account
 * can read and the public http(s) URL Facebook fetches by itself (E5 requires
 * one URL per photo; create-post-batch rejects anything that is not http(s)).
 *
 * Pure TypeScript: imports stay inside core/domain (docs/07 section 2). The MAC
 * itself is computed by an adapter (node:crypto is I/O-layer); this module owns
 * the canonical payload, the query shape and the verdict rules so that signer
 * and verifier can never drift apart.
 *
 * Threat model: the route is unauthenticated on purpose — Meta's fetcher carries
 * no session. The signature therefore binds tenant + asset + expiry, and the
 * verifier answers with a REASON CODE only; nothing derived from the secret ever
 * leaves this module.
 */

import { AppError } from "./errors";
import { isTenantId } from "./tenant";

/** Route prefix served by the web app: `/api/media/<mediaAssetId>?...`. */
export const MEDIA_ROUTE_PREFIX = "/api/media";

/** Query parameter names. Published contract — ui-web reads exactly these. */
export const MEDIA_QUERY_PARAMS = {
  tenant: "tenant",
  expires: "expires",
  signature: "sig",
} as const;

/** Bumped whenever the payload layout changes; old links then stop verifying. */
export const MEDIA_SIGNATURE_VERSION = "v1";

/**
 * Default lifetime. Long enough to survive the queue: a job may wait for the
 * per-channel spacing and up to `maxAttempts` exponential retries before Meta
 * fetches the photo. Too short = a retried post fails with a dead URL.
 */
export const DEFAULT_MEDIA_URL_TTL_MS = 6 * 60 * 60 * 1000;
/** Hard ceiling — a signed link is a bearer token; it must not live for days. */
export const MAX_MEDIA_URL_TTL_MS = 24 * 60 * 60 * 1000;
/** Below this a link expires before the worker can even pick the job up. */
export const MIN_MEDIA_URL_TTL_MS = 60 * 1000;

/** Drive file ids are `[A-Za-z0-9_-]`; fixture ids add `.` and `-`. */
const ASSET_ID_PATTERN = /^[A-Za-z0-9._-]{1,255}$/;
const HEX_SIGNATURE_PATTERN = /^[0-9a-f]{32,128}$/;

export interface MediaUrlClaims {
  readonly tenantId: string;
  /** Drive file id — the identity of a media asset (names repeat, ids do not). */
  readonly assetId: string;
  readonly expiresAtMs: number;
}

/** Computes the MAC of a canonical payload. Implemented in adapters/crypto. */
export type SignatureFn = (payload: string) => string;

export interface SignMediaUrlInput extends Omit<MediaUrlClaims, "expiresAtMs"> {
  /** Public origin Meta will call, e.g. `https://mysp.example.com`. */
  readonly baseUrl: string;
  readonly nowMs: number;
  readonly sign: SignatureFn;
  readonly ttlMs?: number;
}

export interface SignedMediaUrl {
  /** Absolute URL to hand to Graph API / store on the post job. */
  readonly url: string;
  /** Path + query only, for tests and same-origin callers. */
  readonly path: string;
  readonly expiresAtMs: number;
  readonly signature: string;
}

export const MEDIA_URL_REJECTIONS = [
  "MALFORMED_CLAIMS",
  "MISSING_SIGNATURE",
  "EXPIRED",
  "EXPIRY_TOO_FAR",
  "BAD_SIGNATURE",
] as const;
export type MediaUrlRejection = (typeof MEDIA_URL_REJECTIONS)[number];

export type MediaUrlVerdict =
  | { readonly ok: true; readonly claims: MediaUrlClaims }
  | { readonly ok: false; readonly reason: MediaUrlRejection };

export interface VerifyMediaUrlInput {
  readonly tenantId: unknown;
  readonly assetId: unknown;
  /** Milliseconds since epoch. A query string value may arrive as text. */
  readonly expiresAt: unknown;
  readonly signature: unknown;
  readonly nowMs: number;
  readonly sign: SignatureFn;
}

/**
 * Canonical payload. Newline-separated with a version tag so that no field can
 * absorb another one's content ("a\nb" is rejected below, so the split is
 * unambiguous).
 */
export function mediaSignaturePayload(claims: MediaUrlClaims): string {
  const normalised = normaliseClaims(claims);
  if (!normalised) {
    throw new AppError("INVALID_INPUT", {
      message: "mediaSignaturePayload requires a tenant UUID, an asset id and an expiry",
      userMessage: "Không tạo được liên kết ảnh — dữ liệu đầu vào không hợp lệ.",
      // Never the signature or the secret: only what identifies the asset.
      context: {
        tenant_id: typeof claims?.tenantId === "string" ? claims.tenantId : null,
        drive_file_id: typeof claims?.assetId === "string" ? claims.assetId : null,
      },
    });
  }
  return [
    MEDIA_SIGNATURE_VERSION,
    normalised.tenantId,
    normalised.assetId,
    String(normalised.expiresAtMs),
  ].join("\n");
}

/** Builds the signed URL. Pure: the caller injects both the clock and the MAC. */
export function signMediaUrl(input: SignMediaUrlInput): SignedMediaUrl {
  // --- Edge cases first ------------------------------------------------------
  const baseUrl = trimEnd(str(input?.baseUrl));
  if (!/^https?:\/\/[^\s/]+/i.test(baseUrl)) {
    throw new AppError("INVALID_INPUT", {
      message: "signMediaUrl requires an absolute http(s) base URL",
      userMessage: "Chưa cấu hình địa chỉ công khai để Facebook tải ảnh.",
      context: { base_url: baseUrl || null },
    });
  }
  if (typeof input?.sign !== "function") {
    throw new AppError("INVALID_INPUT", {
      message: "signMediaUrl requires a signature function",
      userMessage: "Không tạo được liên kết ảnh — thiếu cấu hình ký liên kết.",
      context: { tenant_id: str(input?.tenantId) || null },
    });
  }

  const nowMs = input?.nowMs;
  if (!Number.isFinite(nowMs)) {
    throw new AppError("INVALID_INPUT", {
      message: "signMediaUrl requires a numeric clock reading",
      userMessage: "Không tạo được liên kết ảnh — đồng hồ hệ thống không hợp lệ.",
      context: { now_ms: String(nowMs) },
    });
  }

  const ttlMs = resolveTtl(input?.ttlMs);
  const claims: MediaUrlClaims = {
    tenantId: str(input?.tenantId),
    assetId: str(input?.assetId),
    expiresAtMs: Math.floor(nowMs + ttlMs),
  };

  // Throws on malformed claims — a link that cannot be verified must not exist.
  const signature = input.sign(mediaSignaturePayload(claims));
  if (typeof signature !== "string" || signature.length === 0) {
    throw new AppError("INVALID_INPUT", {
      message: "The signature function returned an empty value",
      userMessage: "Không tạo được liên kết ảnh — lỗi ký liên kết.",
      context: { tenant_id: claims.tenantId, drive_file_id: claims.assetId },
    });
  }

  const path = buildMediaPath({ ...claims, signature });
  return { url: `${baseUrl}${path}`, path, expiresAtMs: claims.expiresAtMs, signature };
}

/** Path + query for already-signed claims. Kept separate so tests can rebuild it. */
export function buildMediaPath(input: MediaUrlClaims & { signature: string }): string {
  const query = new URLSearchParams([
    [MEDIA_QUERY_PARAMS.tenant, input.tenantId],
    [MEDIA_QUERY_PARAMS.expires, String(input.expiresAtMs)],
    [MEDIA_QUERY_PARAMS.signature, input.signature],
  ]);
  return `${MEDIA_ROUTE_PREFIX}/${encodeURIComponent(input.assetId)}?${query.toString()}`;
}

/**
 * Verdict for an incoming request. Returns a value (never throws) so the caller
 * decides the error code; the reason is a code, never the expected signature.
 */
export function verifyMediaUrlSignature(input: VerifyMediaUrlInput): MediaUrlVerdict {
  // --- Edge cases first ------------------------------------------------------
  const expiresAtMs = toEpochMs(input?.expiresAt);
  const claims = normaliseClaims({
    tenantId: str(input?.tenantId),
    assetId: str(input?.assetId),
    expiresAtMs: expiresAtMs ?? Number.NaN,
  });
  if (!claims) return { ok: false, reason: "MALFORMED_CLAIMS" };

  const signature = str(input?.signature).toLowerCase();
  if (!HEX_SIGNATURE_PATTERN.test(signature)) return { ok: false, reason: "MISSING_SIGNATURE" };

  const nowMs = input?.nowMs;
  if (!Number.isFinite(nowMs)) return { ok: false, reason: "MALFORMED_CLAIMS" };
  if (claims.expiresAtMs <= nowMs) return { ok: false, reason: "EXPIRED" };
  // A link valid for longer than the ceiling can only come from a signer bug or
  // a leaked secret; refuse it even when the MAC checks out.
  if (claims.expiresAtMs - nowMs > MAX_MEDIA_URL_TTL_MS) {
    return { ok: false, reason: "EXPIRY_TOO_FAR" };
  }
  if (typeof input?.sign !== "function") return { ok: false, reason: "MALFORMED_CLAIMS" };

  const expected = input.sign(mediaSignaturePayload(claims));
  if (typeof expected !== "string" || !equalsInConstantTime(expected.toLowerCase(), signature)) {
    return { ok: false, reason: "BAD_SIGNATURE" };
  }
  return { ok: true, claims };
}

/**
 * Length-independent comparison. Both operands are hex MACs of fixed size, so
 * the early length exit leaks nothing an attacker does not already know.
 */
export function equalsInConstantTime(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) {
    diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return diff === 0;
}

// --- helpers ----------------------------------------------------------------

function normaliseClaims(claims: MediaUrlClaims | undefined): MediaUrlClaims | null {
  const tenantId = str(claims?.tenantId);
  const assetId = str(claims?.assetId);
  const expiresAtMs = claims?.expiresAtMs;

  if (!isTenantId(tenantId)) return null;
  if (!ASSET_ID_PATTERN.test(assetId)) return null;
  if (typeof expiresAtMs !== "number" || !Number.isSafeInteger(expiresAtMs) || expiresAtMs <= 0) {
    return null;
  }
  return { tenantId, assetId, expiresAtMs };
}

function resolveTtl(ttlMs: unknown): number {
  if (typeof ttlMs !== "number" || !Number.isFinite(ttlMs)) return DEFAULT_MEDIA_URL_TTL_MS;
  // Clamp instead of throwing: a caller asking for 10 days gets a day, and a
  // caller asking for a second gets a minute — both are still verifiable.
  return Math.min(Math.max(Math.floor(ttlMs), MIN_MEDIA_URL_TTL_MS), MAX_MEDIA_URL_TTL_MS);
}

function toEpochMs(value: unknown): number | null {
  if (typeof value === "number") return Number.isSafeInteger(value) ? value : null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!/^\d{1,15}$/.test(trimmed)) return null;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function trimEnd(value: string): string {
  return value.replace(/\/+$/, "");
}
