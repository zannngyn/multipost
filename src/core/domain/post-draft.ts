/**
 * Compose draft — the anti-data-loss buffer of the "Soạn bài" screen.
 *
 * Two rules shape this file and neither is negotiable:
 *
 *  - A draft holds ONLY what the operator TYPED. No composed product content,
 *    no inventory, no price, no production note, no signed media URL. Business
 *    rule 2 (whitelist) and rule 3 (stock rechecked on every compose) both break
 *    the moment a draft can carry that data: reopening a draft must re-read the
 *    Sheet and re-run the stock gate, not replay a snapshot taken hours ago.
 *  - Anything forbidden that DOES arrive is rejected loudly with an error code
 *    (business rule 5). Silently stripping the key would hide a client bug that
 *    is, by definition, leaking internal data into browser storage.
 *
 * Pure TypeScript + zod (schema-at-the-boundary, no I/O). See docs/07 §2.
 */

import { z } from "zod";

import { AppError, type ErrorContext } from "./errors";
import { isTenantId } from "./tenant";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Bumped whenever the payload shape changes in a way older drafts cannot satisfy. */
export const POST_DRAFT_SCHEMA_VERSION = 1;

/**
 * Hard ceiling on one stored draft. 64 KiB is ~15x the biggest realistic draft
 * (a few captions plus id lists); anything beyond it is a client bug or an
 * attempt to park data in the DB, and both must fail with a distinct code
 * instead of bloating a row that is written every few seconds.
 */
export const POST_DRAFT_MAX_BYTES = 64 * 1024;

/** The only draft kind Phase 1 writes: the compose wizard. */
export const POST_DRAFT_KIND_COMPOSE = "compose";

/** Wizard steps — mirrors `COMPOSE_STEPS` slugs in the UI. */
export const COMPOSE_DRAFT_STEPS = ["san-pham", "caption", "xem-lai"] as const;
export type ComposeDraftStep = (typeof COMPOSE_DRAFT_STEPS)[number];

/** Mirrors `ScheduleMode` of useScheduleChoice — raw form state, not a resolved instant. */
export const COMPOSE_DRAFT_SCHEDULE_MODES = ["now", "scheduled"] as const;
export type ComposeDraftScheduleMode = (typeof COMPOSE_DRAFT_SCHEDULE_MODES)[number];

/**
 * Keys that must NEVER appear at any depth of a draft. Matching is done on a
 * normalised key (lower-cased, `_`/`-`/spaces removed), so `Price`, `LUU_Y` and
 * `media-url` are caught too.
 */
export const POST_DRAFT_FORBIDDEN_KEYS = [
  "stock",
  "inventory",
  "price",
  "prices",
  "note",
  "notes",
  "luu_y",
  "ton",
  "mediaUrl",
  "signedUrl",
  "url",
] as const;

const FORBIDDEN_KEYS_NORMALISED = new Set(POST_DRAFT_FORBIDDEN_KEYS.map(normaliseKey));

/** Field caps. Generous for humans, tight enough that no single field can fill 64 KiB. */
const MAX_CAPTION_LENGTH = 20_000;
const MAX_SHORT_TEXT = 256;
const MAX_KEY_LENGTH = 128;
const MAX_CHANNEL_ENTRIES = 64;
const MAX_ALBUM_ENTRIES = 200;
/** The payload is 2 levels deep; deeper input is not our shape and is refused. */
const MAX_NESTING_DEPTH = 6;
/** `kind` is a route/table discriminator, not free text. */
const KIND_PATTERN = /^[a-z0-9-]{1,40}$/;

// ---------------------------------------------------------------------------
// Payload
// ---------------------------------------------------------------------------

export interface ComposeDraftSchedule {
  /** "now" = đăng ngay; "scheduled" = hẹn giờ. */
  mode: ComposeDraftScheduleMode;
  /** Raw `datetime-local` string as typed. Resolved (and re-validated) at submit. */
  value: string;
}

/**
 * Everything the operator typed on the compose screen — and nothing else.
 *
 * Empty strings are LEGAL: autosave fires while step 1 is still half-filled, and
 * refusing a half-filled draft would defeat the whole feature.
 */
export interface ComposeDraftPayload {
  step: ComposeDraftStep;
  /** `productCode|color|mediaKind|videoTarget`, normalised by the wizard. */
  composeKey: string;
  productCode: string;
  color: string;
  mediaKind: "image" | "video";
  videoTarget: "facebook_video" | "facebook_reels";
  source: "drive" | "upload";
  /** channelId -> caption text (the wizard's own per-channel editor). */
  captions: Record<string, string>;
  /** channelId -> caption text (per-channel override on the publish form). */
  captionOverrides: Record<string, string>;
  /** assetId in publish order; `[0]` is the cover. */
  albumOrder: string[];
  selectedChannelIds: string[];
  shareCaption: boolean;
  schedule: ComposeDraftSchedule;
  /** ISO-8601, stamped by the client — used to pick the newer of server/local. */
  savedAt: string;
}

const channelTextRecord = z
  .record(z.string().min(1).max(MAX_KEY_LENGTH), z.string().max(MAX_CAPTION_LENGTH))
  .refine((record) => Object.keys(record).length <= MAX_CHANNEL_ENTRIES, {
    message: `must not carry more than ${MAX_CHANNEL_ENTRIES} channels`,
  });

const idList = z.array(z.string().min(1).max(MAX_SHORT_TEXT)).max(MAX_ALBUM_ENTRIES);

/**
 * `strictObject`: an unknown key means the client and this schema disagree about
 * what a draft is. That is exactly the situation where data we do not want
 * persisted (composed content, stock, URLs) sneaks in, so it fails.
 */
const composeDraftPayloadSchema = z.strictObject({
  step: z.enum(COMPOSE_DRAFT_STEPS),
  composeKey: z.string().max(MAX_SHORT_TEXT),
  productCode: z.string().max(MAX_SHORT_TEXT),
  color: z.string().max(MAX_SHORT_TEXT),
  mediaKind: z.enum(["image", "video"]),
  videoTarget: z.enum(["facebook_video", "facebook_reels"]),
  source: z.enum(["drive", "upload"]),
  captions: channelTextRecord,
  captionOverrides: channelTextRecord,
  albumOrder: idList,
  selectedChannelIds: idList,
  shareCaption: z.boolean(),
  schedule: z.strictObject({
    mode: z.enum(COMPOSE_DRAFT_SCHEDULE_MODES),
    value: z.string().max(MAX_SHORT_TEXT),
  }),
  savedAt: z
    .string()
    .max(40)
    .refine((value) => Number.isFinite(Date.parse(value)), {
      message: "must be an ISO-8601 timestamp",
    }),
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function normaliseKey(key: string): string {
  return key.toLowerCase().replace(/[\s_-]/g, "");
}

function rejected(message: string, context: ErrorContext, cause?: unknown): AppError {
  return new AppError("DRAFT_PAYLOAD_REJECTED", { message, context, cause });
}

/** UTF-8 byte size of the payload as it will be stored. */
function jsonByteSize(value: unknown): number {
  let json: string;
  try {
    json = JSON.stringify(value) ?? "";
  } catch (error) {
    // Circular reference / BigInt: unstorable, and never produced by our client.
    throw rejected(
      "Draft payload is not JSON-serialisable",
      { reason: "NOT_SERIALISABLE" },
      error,
    );
  }
  return new TextEncoder().encode(json).byteLength;
}

interface ForbiddenHit {
  readonly key: string;
  readonly path: string;
}

/**
 * First forbidden key anywhere in the value, or null.
 *
 * Recursion is depth-capped and the cap THROWS rather than returning null: a
 * structure deeper than the payload shape could otherwise hide a forbidden key
 * below the last inspected level.
 */
function findForbiddenKey(value: unknown, path: string, depth: number): ForbiddenHit | null {
  if (depth > MAX_NESTING_DEPTH) {
    throw rejected("Draft payload is nested deeper than the draft shape allows", {
      reason: "TOO_DEEP",
      path: path || "$",
      max_depth: MAX_NESTING_DEPTH,
    });
  }

  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const hit = findForbiddenKey(value[index], `${path}[${index}]`, depth + 1);
      if (hit) return hit;
    }
    return null;
  }

  if (typeof value !== "object" || value === null) return null;

  for (const [key, child] of Object.entries(value)) {
    const childPath = path ? `${path}.${key}` : key;
    if (FORBIDDEN_KEYS_NORMALISED.has(normaliseKey(key))) return { key, path: childPath };
    const hit = findForbiddenKey(child, childPath, depth + 1);
    if (hit) return hit;
  }

  return null;
}

/** zod issues in the shape `http-errors.extractIssues` already understands. */
function issuesOf(error: z.ZodError): { path: string; message: string }[] {
  return error.issues.slice(0, 10).map((issue) => ({
    path: issue.path.join("."),
    message: issue.message,
  }));
}

/**
 * Parses an untrusted draft payload. Order is deliberate — cheapest and most
 * dangerous checks first:
 *   1. is it an object at all,
 *   2. does it fit the size cap (DRAFT_TOO_LARGE),
 *   3. does it carry a forbidden key at any depth (DRAFT_PAYLOAD_REJECTED),
 *   4. does it match the draft shape (DRAFT_PAYLOAD_REJECTED).
 *
 * Never mutates and never strips: a rejected payload comes back as an error the
 * caller can show and log, not as a quietly cleaned object.
 */
export function assertComposeDraftPayload(value: unknown): ComposeDraftPayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw rejected("Draft payload must be a JSON object", {
      reason: "NOT_AN_OBJECT",
      received: value === null ? "null" : Array.isArray(value) ? "array" : typeof value,
    });
  }

  const bytes = jsonByteSize(value);
  if (bytes > POST_DRAFT_MAX_BYTES) {
    throw new AppError("DRAFT_TOO_LARGE", {
      message: `Draft payload is ${bytes} bytes, over the ${POST_DRAFT_MAX_BYTES} byte limit`,
      context: { reason: "OVER_SIZE_LIMIT", bytes, limit_bytes: POST_DRAFT_MAX_BYTES },
    });
  }

  const forbidden = findForbiddenKey(value, "", 0);
  if (forbidden) {
    throw rejected(`Draft payload carries forbidden key "${forbidden.key}"`, {
      reason: "FORBIDDEN_KEY",
      key: forbidden.key,
      path: forbidden.path,
    });
  }

  const parsed = composeDraftPayloadSchema.safeParse(value);
  if (!parsed.success) {
    throw rejected("Draft payload does not match the compose draft schema", {
      reason: "SCHEMA_MISMATCH",
      issues: issuesOf(parsed.error),
    });
  }

  return parsed.data;
}

/** Same checks, but reports instead of throwing — for readers of stored rows. */
export function parseComposeDraftPayload(
  value: unknown,
): { ok: true; payload: ComposeDraftPayload } | { ok: false; error: AppError } {
  try {
    return { ok: true, payload: assertComposeDraftPayload(value) };
  } catch (error) {
    // Only the two draft codes are expected here; anything else is a real bug
    // and must not be disguised as "invalid draft".
    const appError = AppError.from(error, "INTERNAL");
    if (appError.code !== "DRAFT_PAYLOAD_REJECTED" && appError.code !== "DRAFT_TOO_LARGE") {
      throw appError;
    }
    return { ok: false, error: appError };
  }
}

// ---------------------------------------------------------------------------
// Addressing — a draft is (tenant, owner, kind), never just (tenant)
// ---------------------------------------------------------------------------

/** Same loose 8-4-4-4-12 shape as `isTenantId`: fixture ids carry no version nibble. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The one way a draft operation ends without touching the server AND without
 * being a failure: the caller has no session e-mail, or that e-mail matches no
 * `app_user` row of this tenant (a real state of a dev/demo environment).
 *
 * It is a named reason, never an absent field: a draft that was not stored must
 * be impossible to mistake for one that was (business rule 5). The screen turns
 * it into "nháp chỉ lưu trên máy này".
 */
export const POST_DRAFT_NO_USER = "NO_USER";

export interface PostDraftNotPersisted {
  readonly persisted: false;
  readonly reason: typeof POST_DRAFT_NO_USER;
}

/** The single value every draft usecase returns for the no-owner branch. */
export const POST_DRAFT_NOT_PERSISTED: PostDraftNotPersisted = Object.freeze({
  persisted: false,
  reason: POST_DRAFT_NO_USER,
});

/**
 * How a caller says who the draft belongs to.
 *
 * `ownerUserId` wins when both are given (same rule as `ActorInput`); a caller
 * that only has a session hands over `ownerEmail` and the usecase resolves it.
 * Neither given = nobody to own the draft = `POST_DRAFT_NOT_PERSISTED`.
 *
 * "Given" means anything other than `undefined`/`null`: an `ownerUserId` that is
 * present but blank or malformed is a caller BUG and fails with INVALID_INPUT,
 * never a silent fall back to the e-mail path (which would turn a broken client
 * into a draft that quietly stops being stored).
 */
export interface PostDraftOwnerInput {
  readonly ownerUserId?: string | null;
  readonly ownerEmail?: string | null;
}

export interface PostDraftScope {
  readonly tenantId: string;
  readonly kind: string;
}

export interface PostDraftAddress extends PostDraftScope {
  readonly ownerUserId: string;
}

export interface PostDraftScopeInput {
  readonly tenantId?: unknown;
  readonly kind?: unknown;
}

export interface PostDraftAddressInput extends PostDraftScopeInput {
  readonly ownerUserId?: unknown;
}

/**
 * Validates the half of the address that is known BEFORE the owner is resolved.
 *
 * Split out on purpose: a draft usecase must reject a malformed tenant/kind (a
 * caller bug) before it asks any repository who the operator is, so a bad
 * request never reaches the database.
 */
export function assertPostDraftScope(
  input: PostDraftScopeInput | null | undefined,
): PostDraftScope {
  const tenantId = typeof input?.tenantId === "string" ? input.tenantId.trim() : "";
  if (!isTenantId(tenantId)) {
    throw new AppError("INVALID_INPUT", {
      message: "tenantId must be a UUID",
      userMessage: "Mã đơn vị (tenant) không hợp lệ.",
      context: { tenant_id: tenantId || null, reason: "INVALID_TENANT_ID" },
    });
  }

  return { tenantId, kind: normalisePostDraftKind(input?.kind) };
}

/**
 * Validates and trims the triple every draft operation is addressed by.
 *
 * `ownerUserId` is mandatory and must be a uuid: without it a draft is not
 * tenant-scoped but tenant-SHARED, and two operators would overwrite each
 * other's work. A caller that could not resolve an owner must not build an
 * address at all — the usecase answers `persisted: false` / `NO_USER` and the
 * screen reports "chỉ lưu trên máy này".
 */
export function assertPostDraftAddress(
  input: PostDraftAddressInput | null | undefined,
): PostDraftAddress {
  const scope = assertPostDraftScope(input);

  const ownerUserId = typeof input?.ownerUserId === "string" ? input.ownerUserId.trim() : "";
  if (!UUID_PATTERN.test(ownerUserId)) {
    throw new AppError("INVALID_INPUT", {
      message: "ownerUserId must be a UUID",
      userMessage: "Không xác định được người dùng sở hữu bản nháp.",
      context: { tenant_id: scope.tenantId, reason: "INVALID_OWNER_USER_ID" },
    });
  }

  return { tenantId: scope.tenantId, ownerUserId, kind: scope.kind };
}

/**
 * Normalises the draft kind. Absent/empty means the compose wizard — the only
 * writer Phase 1 has. A malformed kind is a caller bug, not a default.
 */
export function normalisePostDraftKind(value: unknown): string {
  // Absent means "not specified". A value of the wrong TYPE means the caller is
  // confused, and defaulting there would write a draft nobody can find again.
  if (value === undefined || value === null) return POST_DRAFT_KIND_COMPOSE;
  const kind = typeof value === "string" ? value.trim().toLowerCase() : null;
  if (kind !== null && kind.length === 0) return POST_DRAFT_KIND_COMPOSE;
  if (kind === null || !KIND_PATTERN.test(kind)) {
    throw new AppError("INVALID_INPUT", {
      message: "Draft kind must match [a-z0-9-]{1,40}",
      userMessage: "Loại bản nháp không hợp lệ.",
      context: { reason: "INVALID_DRAFT_KIND" },
    });
  }
  return kind;
}
