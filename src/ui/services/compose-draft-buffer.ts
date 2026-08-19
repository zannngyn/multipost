import {
  COMPOSE_DRAFT_SCHEMA_VERSION,
  ComposeDraftBufferEntrySchema,
  DRAFT_PAYLOAD_REJECTED,
  exceedsComposeDraftLimit,
  parseComposeDraftPayload,
  type ComposeDraftPayload,
} from "@/ui/schemas/post-draft.schema";

/**
 * `localStorage` buffer for the compose draft.
 *
 * WHAT THIS IS: the thing that catches what the operator typed in the seconds
 * between two autosaves. The SOURCE OF TRUTH IS THE SERVER (`post_draft`) —
 * this only exists because a tab can close while a PUT is still in flight, and
 * because browser storage is not a place to rely on: it is wiped on low disk,
 * it is per-machine, and it is off entirely in some privacy modes
 * (core-offline-pwa: never treat client storage as the only copy).
 *
 * WHY IT IS NOT "just a setItem":
 *  - reading storage at module load would run on the server and break hydration
 *    (web-state-architecture rule 5) — every access happens inside a call, and
 *    every call works when there is no `window` at all;
 *  - `window.localStorage` THROWS on access when the browser blocks storage,
 *    and `setItem` throws `QuotaExceededError` in Safari private mode where the
 *    quota is zero. Both are handled by name and reported, never swallowed
 *    (CLAUDE.md technical rule 5);
 *  - anything read back is external data and goes through zod before it can
 *    reach a form; a corrupt or expired entry is deleted, not repaired.
 *
 * Nothing here decides anything about a post. It stores keystrokes.
 */

/** Version is IN the key: an old build must not read an entry it cannot parse. */
export const COMPOSE_DRAFT_BUFFER_KEY_PREFIX = "mysp.compose.draft.v1";

/**
 * Owner suffix used when the server could not name an operator (no `app_user`
 * row for the session). It is a REAL scope, not a fallback to "everyone": an
 * anonymous session reads and writes its own bucket and can never pick up the
 * draft of a named operator who used this machine earlier.
 */
export const ANONYMOUS_OWNER_KEY = "anon";

/**
 * A draft older than this is not offered back. Reopening yesterday's half-typed
 * post as if it were current is the "âm thầm khôi phục bản nháp" mistake
 * core-wizard forbids.
 *
 * Scope: THIS BUFFER ONLY. The server copy has no age limit — it is offered back
 * however old it is. Do not describe the two as sharing one rule.
 */
export const COMPOSE_DRAFT_BUFFER_TTL_MS = 24 * 60 * 60 * 1000;

export type ComposeDraftBufferFailure =
  /** No storage in this environment (SSR, or the browser blocks it). */
  | "unavailable"
  /** Called without a usable tenant id — a bug, never the operator's fault. */
  | "invalid-tenant"
  /** The payload itself is not storable (forbidden field, or wrong shape). */
  | "rejected"
  /** Bigger than the server would accept; buffering it would only defer the 413. */
  | "too-large"
  /** Storage is full, or the quota is zero (Safari private mode). */
  | "quota"
  /** Anything else `localStorage` threw. */
  | "storage-error";

export type ComposeDraftBufferResult =
  | { ok: true }
  | { ok: false; reason: ComposeDraftBufferFailure; userMessage: string };

const FAILURE_MESSAGES: Record<ComposeDraftBufferFailure, string> = {
  unavailable: "Trình duyệt không cho lưu tạm trên máy này. Nháp chỉ được giữ trên máy chủ.",
  "invalid-tenant": "Thiếu mã đơn vị nên không lưu tạm được nháp.",
  rejected: "Nháp chứa dữ liệu không được phép lưu nên đã không được lưu tạm.",
  "too-large": "Nháp quá lớn để lưu tạm trên máy. Hãy rút ngắn caption.",
  quota: "Bộ nhớ trình duyệt đã đầy nên không lưu tạm được nháp trên máy này.",
  "storage-error": "Không lưu tạm được nháp trên máy này. Nháp vẫn được lưu trên máy chủ.",
};

function failure(reason: ComposeDraftBufferFailure): ComposeDraftBufferResult {
  return { ok: false, reason, userMessage: FAILURE_MESSAGES[reason] };
}

/**
 * Structured log for the one thing this module can go wrong at.
 *
 * Context only — tenant, action, reason, error name. NEVER the payload: it
 * holds caption text the operator typed (core-frontend-security: no operator
 * data in logs). `console.warn` on purpose: a buffer miss degrades the safety
 * net, it does not stop the screen, and the operator already sees the state.
 */
function logBufferIssue(context: {
  action: "read" | "write" | "clear";
  tenantId: string;
  reason: string;
  detail?: string;
  cause?: unknown;
}): void {
  const cause = context.cause;
  console.warn("[compose-draft-buffer] storage operation failed", {
    scope: "ui/compose-draft-buffer",
    action: context.action,
    tenantId: context.tenantId,
    reason: context.reason,
    detail: context.detail,
    errorName: cause instanceof Error ? cause.name : undefined,
    errorMessage: cause instanceof Error ? cause.message : undefined,
  });
}

/**
 * Storage key of one operator's draft on one machine.
 *
 * The owner is part of the key, exactly as it is part of the DB's unique index
 * `(tenant_id, owner_user_id, kind)` (business rule 7). Without it, a shared
 * workstation leaks: operator A types a draft, operator B signs in on the same
 * browser profile, and B's screen fills up with A's product code and captions —
 * then autosave writes that over B's own row. Signing out does not clear this
 * storage, so the key is the only thing standing between them.
 *
 * `ownerKey` is a one-way hash minted by the server; the raw `app_user.id`
 * never reaches the browser.
 */
export function composeDraftBufferKey(tenantId: string, ownerKey: string): string {
  const owner = typeof ownerKey === "string" && ownerKey.trim().length > 0
    ? ownerKey.trim()
    : ANONYMOUS_OWNER_KEY;
  return `${COMPOSE_DRAFT_BUFFER_KEY_PREFIX}:${tenantId}:${owner}`;
}

/**
 * Marker left behind when the draft could not be deleted from the server after
 * a batch was created.
 *
 * Without it the failure is silent and has a real consequence: the leftover row
 * comes back as a "restore" on the next visit, offering to reopen a post that
 * has already been published. The next mount reads this marker and retries the
 * delete before it reads anything else.
 */
function pendingDiscardKey(tenantId: string, ownerKey: string): string {
  return `${composeDraftBufferKey(tenantId, ownerKey)}:pending-discard`;
}

/**
 * `window.localStorage` can throw on ACCESS (not only on use) when the browser
 * blocks storage for the origin, so even reading the property is guarded.
 * Deliberately not memoised: permission can change while the tab is open.
 */
function getStorage(action: "read" | "write" | "clear", tenantId: string): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage ?? null;
  } catch (cause) {
    logBufferIssue({ action, tenantId, reason: "storage-unavailable", cause });
    return null;
  }
}

function isQuotaError(cause: unknown): boolean {
  if (typeof DOMException !== "undefined" && cause instanceof DOMException) {
    // Firefox reports its own name; the codes cover browsers that predate names.
    return (
      cause.name === "QuotaExceededError" ||
      cause.name === "NS_ERROR_DOM_QUOTA_REACHED" ||
      cause.code === 22 ||
      cause.code === 1014
    );
  }
  return cause instanceof Error && cause.name === "QuotaExceededError";
}

function removeKey(
  storage: Storage,
  address: ComposeDraftAddress,
  action: "read" | "clear",
): boolean {
  try {
    storage.removeItem(composeDraftBufferKey(address.tenantId, address.ownerKey));
    return true;
  } catch (cause) {
    logBufferIssue({ action, tenantId: address.tenantId, reason: "remove-failed", cause });
    return false;
  }
}

/**
 * WHO the draft belongs to, on WHICH tenant. Both halves are required for every
 * call — the same pair the DB indexes on.
 */
export interface ComposeDraftAddress {
  readonly tenantId: string;
  /** One-way hash of `app_user.id` from the API, or "anon". */
  readonly ownerKey: string;
}

function normaliseAddress(address: ComposeDraftAddress): ComposeDraftAddress | null {
  const tenantId = typeof address?.tenantId === "string" ? address.tenantId.trim() : "";
  if (tenantId.length === 0) return null;
  const ownerKey =
    typeof address?.ownerKey === "string" && address.ownerKey.trim().length > 0
      ? address.ownerKey.trim()
      : ANONYMOUS_OWNER_KEY;
  return { tenantId, ownerKey };
}

/**
 * The buffered draft, or `null` when there is nothing usable.
 *
 * `null` covers four different things on purpose — no entry, expired, corrupt,
 * written by another version. All four end the same way: the entry is deleted
 * and the caller falls back to the server copy. The reason is logged, so "why
 * did my draft not come back" is answerable without a debugger.
 *
 * `nowMs` is injected so the TTL is testable and so a screen can pass the clock
 * it already reads instead of taking a second one.
 */
function read(
  address: ComposeDraftAddress,
  nowMs: number = Date.now(),
): ComposeDraftPayload | null {
  // --- Edge cases first ----------------------------------------------------
  const at = normaliseAddress(address);
  if (at === null) return null;
  const tenant = at.tenantId;

  const storage = getStorage("read", tenant);
  if (storage === null) return null;

  let raw: string | null;
  try {
    raw = storage.getItem(composeDraftBufferKey(at.tenantId, at.ownerKey));
  } catch (cause) {
    logBufferIssue({ action: "read", tenantId: tenant, reason: "get-failed", cause });
    return null;
  }
  if (raw === null || raw.length === 0) return null;

  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch (cause) {
    logBufferIssue({ action: "read", tenantId: tenant, reason: "malformed-json", cause });
    removeKey(storage, at, "read");
    return null;
  }

  const entry = ComposeDraftBufferEntrySchema.safeParse(decoded);
  if (!entry.success) {
    logBufferIssue({
      action: "read",
      tenantId: tenant,
      reason: "schema-mismatch",
      // Paths only: the entry holds caption text.
      detail: entry.error.issues.map((issue) => issue.path.join(".")).join(", "),
    });
    removeKey(storage, at, "read");
    return null;
  }

  // A caller that hands over a broken clock must not cost the operator a draft.
  const ageMs = (Number.isFinite(nowMs) ? nowMs : Date.now()) - Date.parse(entry.data.storedAt);
  // A negative age means the clock moved backwards (or the entry was written by
  // a machine ahead of this one) — treat it as untrustworthy rather than fresh.
  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > COMPOSE_DRAFT_BUFFER_TTL_MS) {
    logBufferIssue({
      action: "read",
      tenantId: tenant,
      reason: "expired",
      detail: `ageMs=${ageMs}`,
    });
    removeKey(storage, at, "read");
    return null;
  }

  return entry.data.payload;
}

/**
 * Mirrors the payload to storage. The caller keeps the server PUT as the real
 * save; this is the copy that survives a closed tab.
 *
 * Validated on the way IN as well as on the way out: a payload carrying stock
 * or a signed URL must never be written to a machine we do not control, and a
 * rejection here surfaces the bug at the keystroke instead of at the 422.
 */
function write(
  address: ComposeDraftAddress,
  payload: ComposeDraftPayload,
  nowMs: number = Date.now(),
): ComposeDraftBufferResult {
  // --- Edge cases first ----------------------------------------------------
  const at = normaliseAddress(address);
  if (at === null) return failure("invalid-tenant");
  const tenant = at.tenantId;

  // Size BEFORE shape, mirroring `assertComposeDraftPayload` in core: an
  // oversized draft must answer "too large" on both sides, not "rejected" here
  // and 413 there.
  if (exceedsComposeDraftLimit(payload)) {
    logBufferIssue({ action: "write", tenantId: tenant, reason: "too-large" });
    return failure("too-large");
  }

  const verdict = parseComposeDraftPayload(payload);
  if (!verdict.ok) {
    logBufferIssue({
      action: "write",
      tenantId: tenant,
      reason: verdict.code,
      detail:
        verdict.code === DRAFT_PAYLOAD_REJECTED
          ? verdict.forbiddenPaths.join(", ")
          : verdict.issuePaths.join(", "),
    });
    // The caller's own message is kept: it names WHAT was refused, which is more
    // use to whoever has to fix it than a generic "không lưu được".
    return { ok: false, reason: "rejected", userMessage: verdict.userMessage };
  }

  const entry = {
    schemaVersion: COMPOSE_DRAFT_SCHEMA_VERSION,
    // The buffer's OWN clock, not `payload.savedAt`: the TTL is about how long
    // this machine has been holding the entry.
    storedAt: new Date(Number.isFinite(nowMs) ? nowMs : Date.now()).toISOString(),
    payload: verdict.payload,
  };

  const storage = getStorage("write", tenant);
  if (storage === null) return failure("unavailable");

  try {
    storage.setItem(composeDraftBufferKey(at.tenantId, at.ownerKey), JSON.stringify(entry));
    return { ok: true };
  } catch (cause) {
    const quota = isQuotaError(cause);
    logBufferIssue({
      action: "write",
      tenantId: tenant,
      reason: quota ? "quota-exceeded" : "set-failed",
      cause,
    });
    // The older entry is deliberately LEFT in place: it is still a draft of this
    // tenant's post, and the restore step picks whichever of server/buffer is
    // newer. Deleting it here would turn a failed save into lost work.
    return failure(quota ? "quota" : "storage-error");
  }
}

/** Drops the buffered draft (batch created, or the operator discarded it). */
function clear(address: ComposeDraftAddress): ComposeDraftBufferResult {
  const at = normaliseAddress(address);
  if (at === null) return failure("invalid-tenant");

  const storage = getStorage("clear", at.tenantId);
  if (storage === null) return failure("unavailable");

  return removeKey(storage, at, "clear") ? { ok: true } : failure("storage-error");
}

/**
 * Records that the server still holds a draft nobody wants any more.
 *
 * Called when the DELETE after a successful publish fails. Storage, not memory:
 * by then the screen is navigating to the batch page, so a flag in React state
 * would die with the component and the stale row would come back as a "restore"
 * next time (business rule 5 — no failure disappears quietly).
 */
function markPendingDiscard(address: ComposeDraftAddress): ComposeDraftBufferResult {
  const at = normaliseAddress(address);
  if (at === null) return failure("invalid-tenant");

  const storage = getStorage("write", at.tenantId);
  if (storage === null) return failure("unavailable");

  try {
    storage.setItem(pendingDiscardKey(at.tenantId, at.ownerKey), new Date().toISOString());
    return { ok: true };
  } catch (cause) {
    logBufferIssue({
      action: "write",
      tenantId: at.tenantId,
      reason: "pending-discard-write-failed",
      cause,
    });
    return failure(isQuotaError(cause) ? "quota" : "storage-error");
  }
}

/** Reads and consumes the marker: true = the caller must retry the delete. */
function takePendingDiscard(address: ComposeDraftAddress): boolean {
  const at = normaliseAddress(address);
  if (at === null) return false;

  const storage = getStorage("read", at.tenantId);
  if (storage === null) return false;

  const key = pendingDiscardKey(at.tenantId, at.ownerKey);
  try {
    const marker = storage.getItem(key);
    if (marker === null) return false;
    storage.removeItem(key);
    return true;
  } catch (cause) {
    logBufferIssue({
      action: "read",
      tenantId: at.tenantId,
      reason: "pending-discard-read-failed",
      cause,
    });
    return false;
  }
}

export const composeDraftBuffer = {
  read,
  write,
  clear,
  markPendingDiscard,
  takePendingDiscard,
} as const;
