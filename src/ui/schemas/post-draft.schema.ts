import { z } from "zod";

import { MediaKindSchema, MediaSourceSchema, VideoTargetSchema } from "./compose.schema";

/**
 * Client-side contract of the compose draft (`post_draft.payload`, kind
 * "compose").
 *
 * `ui/` may not import `core/` (one-way dependency law, docs/07 §2), so this
 * MIRRORS `core/domain/post-draft.ts`. It is the boundary schema of the browser
 * side: everything that comes back from the draft API, and everything read out
 * of `localStorage`, is parsed through it before a single field reaches a form
 * (CLAUDE.md technical rule 2 — external data is never trusted, and the buffer
 * on the operator's own machine IS external data: another tab, an older build
 * or a hand-edited entry can all put anything in there).
 *
 * WHAT A DRAFT MAY CONTAIN — only what the operator TYPED or PICKED:
 *  - no `composed` result: reopening a draft re-runs the lookup and the stock
 *    gate for real (business rule 3), so a cached ProductContent would only be
 *    a chance to show yesterday's data;
 *  - no stock, price or production note: those are internal, they never leave
 *    the operator area (business rule 2) and least of all into a store on a
 *    client machine;
 *  - no media URL: a signed URL expires, and a restored draft full of broken
 *    images looks like a bug in the album.
 *
 * That rule is ENFORCED, not documented: a payload carrying one of the
 * forbidden keys at any depth is REJECTED with a code, never quietly stripped
 * (business rule 5 — nothing is dropped in silence).
 */

/** Mirrors POST_DRAFT_SCHEMA_VERSION in core/domain/post-draft.ts. */
export const COMPOSE_DRAFT_SCHEMA_VERSION = 1;

/** Mirrors POST_DRAFT_MAX_BYTES — the server refuses anything bigger. */
export const COMPOSE_DRAFT_MAX_BYTES = 64 * 1024;

/**
 * Field caps, mirroring the ones in `core/domain/post-draft.ts` EXACTLY.
 *
 * The rule that decides every number here: the client must never refuse what
 * the server accepts. A stricter client is not "safer" — it means a draft that
 * lives happily in the DB is thrown away by the browser that asks for it, which
 * is precisely the data loss this feature exists to stop. Stricter-than-server
 * is a bug; looser is merely a round trip.
 */
const MAX_CAPTION_LENGTH = 20_000;
const MAX_SHORT_TEXT = 256;
const MAX_KEY_LENGTH = 128;
const MAX_CHANNEL_ENTRIES = 64;
const MAX_ID_ENTRIES = 200;

/**
 * Steps of the wizard, in order. MIRRORS `COMPOSE_STEPS` in
 * `ui/hooks/useComposeWizard.ts`; kept here as literals rather than imported so
 * a schema never depends on a hook (component → hook → service → schema is one
 * way). Adding a step means touching both — the parse below is what makes the
 * drift loud instead of silent.
 */
export const COMPOSE_DRAFT_STEPS = ["san-pham", "caption", "xem-lai"] as const;
export const ComposeDraftStepSchema = z.enum(COMPOSE_DRAFT_STEPS);
export type ComposeDraftStep = z.infer<typeof ComposeDraftStepSchema>;

/**
 * The persistable half of `useScheduleChoice` (ui/hooks/useScheduleChoice.ts).
 *
 * That hook holds `{ mode, value, error }`; only the first two are the
 * operator's input. `error` is the verdict of the last `resolve()` against the
 * clock AT THAT INSTANT — restoring it a day later would put a stale sentence
 * on a field the operator has not touched yet, and hide the real verdict.
 *
 * `value` is the raw `datetime-local` wall time ("YYYY-MM-DDTHH:mm"), NOT an
 * instant: it is stored exactly as typed and re-validated on restore, because
 * an hour that was in the future when the draft was saved may be in the past
 * when it is reopened.
 */
export const ComposeDraftScheduleSchema = z.strictObject({
  mode: z.enum(["now", "scheduled"]),
  value: z.string().max(MAX_SHORT_TEXT),
});
export type ComposeDraftSchedule = z.infer<typeof ComposeDraftScheduleSchema>;

/**
 * Keys that must never appear anywhere in a draft payload — the storage-side
 * copy of the whitelist rule. Matched case-insensitively and ignoring `_`/`-`,
 * so `luu_y`, `luuY` and `LUU-Y` are all the same key.
 */
export const FORBIDDEN_DRAFT_KEYS = [
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

/** Same normalisation as `normaliseKey` in core/domain/post-draft.ts. */
function normaliseKey(key: string): string {
  return key.toLowerCase().replace(/[\s_-]/g, "");
}

const FORBIDDEN_KEY_LOOKUP = new Set(FORBIDDEN_DRAFT_KEYS.map(normaliseKey));

/**
 * Every path in `value` whose key is forbidden, e.g. `["schedule.price"]`.
 * Walks plain objects and arrays only; a cycle is impossible in JSON but the
 * visited set keeps a hand-built object from hanging the browser.
 */
export function findForbiddenDraftKeys(value: unknown): string[] {
  const found: string[] = [];
  const visited = new WeakSet<object>();

  const walk = (node: unknown, path: string): void => {
    if (node === null || typeof node !== "object") return;
    if (visited.has(node)) return;
    visited.add(node);

    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${path}[${index}]`));
      return;
    }

    for (const [key, child] of Object.entries(node)) {
      const childPath = path.length > 0 ? `${path}.${key}` : key;
      if (FORBIDDEN_KEY_LOOKUP.has(normaliseKey(key))) found.push(childPath);
      walk(child, childPath);
    }
  };

  walk(value, "");
  return found;
}

/** channelId -> text. Same key/value/entry caps as core's `channelTextRecord`. */
function channelTextRecord() {
  return z
    .record(z.string().min(1).max(MAX_KEY_LENGTH), z.string().max(MAX_CAPTION_LENGTH))
    .refine((record) => Object.keys(record).length <= MAX_CHANNEL_ENTRIES, {
      message: `Tối đa ${MAX_CHANNEL_ENTRIES} kênh trong một nháp.`,
    });
}

/** Same as core's `idList`: non-empty ids, ≤256 chars, ≤200 entries. */
function idList() {
  return z.array(z.string().min(1).max(MAX_SHORT_TEXT)).max(MAX_ID_ENTRIES);
}

/**
 * `strictObject`: an unknown key is a rejection, not something to drop. A draft
 * written by a newer build is not "close enough" — it is a payload we cannot
 * vouch for, and quietly keeping the fields we recognise is how a restored form
 * ends up half old and half new.
 */
export const ComposeDraftPayloadSchema = z
  .strictObject({
    step: ComposeDraftStepSchema,
    /**
     * Identity of what was composed (`productCode|color|mediaKind|videoTarget`,
     * normalised) — mirrors `composeKey()` in useComposeWizard. On restore it
     * decides whether the typed captions still belong to this post.
     */
    composeKey: z.string().max(MAX_SHORT_TEXT),
    /**
     * EMPTY IS LEGAL, exactly as in core. Autosave fires while step 1 is still
     * half-typed, so a client that demanded a product code here would refuse the
     * very draft it exists to save.
     */
    productCode: z.string().max(MAX_SHORT_TEXT),
    /** Optional colour filter, any spelling; "" = every colour of the code. */
    color: z.string().max(MAX_SHORT_TEXT),
    mediaKind: MediaKindSchema,
    videoTarget: VideoTargetSchema,
    source: MediaSourceSchema,
    /** channelId -> approved caption text (the wizard form's `captions`). */
    captions: channelTextRecord(),
    /** channelId -> per-channel edit; an absent key means "same as approved". */
    captionOverrides: channelTextRecord(),
    /**
     * Media ids in PUBLISH order, `[0]` is the cover.
     *
     * The id is `MediaAsset.driveFileId` — the only stable identity a compose
     * response exposes for an album entry (ui/schemas/compose.schema.ts). Files
     * sent through mode B come back in the same shape once composed.
     *
     * Only the ORDER is stored, never a file name or a URL: the album itself is
     * rebuilt by re-composing, and an id that no longer exists is dropped by the
     * restore step with a notice.
     */
    albumOrder: idList(),
    selectedChannelIds: idList(),
    shareCaption: z.boolean(),
    schedule: ComposeDraftScheduleSchema,
    /**
     * Stamped by the client — it is what decides server vs buffer on restore.
     * Same loose check as core (parseable date, ≤40 chars) rather than a strict
     * ISO format: a draft the server stored must never be unreadable here.
     */
    savedAt: z
      .string()
      .max(40)
      .refine((value) => Number.isFinite(Date.parse(value)), {
        message: "savedAt phải là mốc thời gian ISO-8601.",
      }),
  })
  .superRefine((value, ctx) => {
    // Nested forbidden keys survive `strictObject` (a record accepts any key),
    // so the whitelist is re-checked on the whole tree.
    for (const path of findForbiddenDraftKeys(value)) {
      ctx.addIssue({
        code: "custom",
        path: path.split("."),
        message: `Trường "${path}" không được phép nằm trong nháp.`,
      });
    }
  });

export type ComposeDraftPayload = z.infer<typeof ComposeDraftPayloadSchema>;

/**
 * Envelope stored in `localStorage`. The version lives in the value as well as
 * in the key: the key stops an old build from reading a new entry, this stops a
 * new build from reading whatever an old key still holds after a rename.
 */
export const ComposeDraftBufferEntrySchema = z.strictObject({
  schemaVersion: z.literal(COMPOSE_DRAFT_SCHEMA_VERSION),
  /** When the buffer wrote it — the TTL is measured from here. */
  storedAt: z.iso.datetime(),
  payload: ComposeDraftPayloadSchema,
});
export type ComposeDraftBufferEntry = z.infer<typeof ComposeDraftBufferEntrySchema>;

/** Error codes of this boundary — the first two mirror core/domain/errors.ts. */
export const DRAFT_PAYLOAD_REJECTED = "DRAFT_PAYLOAD_REJECTED";
export const DRAFT_TOO_LARGE = "DRAFT_TOO_LARGE";
/** Client-only: the shape is wrong (old build, corrupted entry, hand-edited). */
export const DRAFT_PAYLOAD_INVALID = "DRAFT_PAYLOAD_INVALID";

export type ComposeDraftParseResult =
  | { ok: true; payload: ComposeDraftPayload }
  | {
      ok: false;
      code: typeof DRAFT_PAYLOAD_REJECTED;
      forbiddenPaths: string[];
      userMessage: string;
    }
  | {
      ok: false;
      code: typeof DRAFT_PAYLOAD_INVALID;
      issuePaths: string[];
      userMessage: string;
    };

/**
 * THE parse of a draft payload. Edge cases first, happy path last.
 *
 * Returns a verdict instead of throwing: a bad draft must never take the screen
 * down — it is dropped, said out loud, and the operator keeps working
 * (core-feedback-states: an error with no way forward is a dead end).
 */
export function parseComposeDraftPayload(value: unknown): ComposeDraftParseResult {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {
      ok: false,
      code: DRAFT_PAYLOAD_INVALID,
      issuePaths: [],
      userMessage: "Nháp đã lưu không đọc được nên đã bị bỏ. Hãy soạn lại từ bước 1.",
    };
  }

  // Checked BEFORE the shape: a payload carrying stock or a signed URL is
  // refused for what it contains, not for whether the rest of it parses.
  const forbiddenPaths = findForbiddenDraftKeys(value);
  if (forbiddenPaths.length > 0) {
    return {
      ok: false,
      code: DRAFT_PAYLOAD_REJECTED,
      forbiddenPaths,
      userMessage:
        "Nháp chứa dữ liệu không được phép lưu (tồn kho, giá, ghi chú hoặc đường dẫn ảnh) nên đã bị bỏ.",
    };
  }

  const parsed = ComposeDraftPayloadSchema.safeParse(value);
  if (!parsed.success) {
    return {
      ok: false,
      code: DRAFT_PAYLOAD_INVALID,
      // Paths only — the payload holds caption text we do not put in a log.
      issuePaths: parsed.error.issues.map((issue) => issue.path.join(".")),
      userMessage: "Nháp đã lưu không còn khớp với màn hình này nên đã bị bỏ. Hãy soạn lại từ bước 1.",
    };
  }

  return { ok: true, payload: parsed.data };
}

/** Serialised size in bytes — what both the buffer and the server measure. */
export function composeDraftByteLength(payload: unknown): number {
  return new TextEncoder().encode(JSON.stringify(payload) ?? "").length;
}

export function exceedsComposeDraftLimit(payload: unknown): boolean {
  return composeDraftByteLength(payload) > COMPOSE_DRAFT_MAX_BYTES;
}
