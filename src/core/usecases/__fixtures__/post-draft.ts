import { AppError } from "@/core/domain/errors";
import { POST_DRAFT_SCHEMA_VERSION, type ComposeDraftPayload } from "@/core/domain/post-draft";
import type {
  PostDraftRepo,
  SavePostDraftRecord,
  StoredPostDraft,
} from "@/core/ports/post-draft-repo";
import type { UserRepo } from "@/core/ports/user-repo";

/**
 * Shared test doubles for the draft usecases.
 *
 * The in-memory repo keys rows by (tenant, owner, kind) exactly like the unique
 * index does — that is what makes "upsert twice = one row" and "another tenant
 * sees nothing" testable without Postgres.
 */

/** A payload that passes `assertComposeDraftPayload`. Override one field per test. */
export function validComposeDraftPayload(
  overrides: Partial<ComposeDraftPayload> = {},
): ComposeDraftPayload {
  return {
    step: "caption",
    composeKey: "AB123|đỏ|image|-",
    productCode: "AB123",
    color: "ĐỎ",
    mediaKind: "image",
    videoTarget: "facebook_video",
    source: "drive",
    captions: { facebook: "Váy hoa nhí mùa hè" },
    captionOverrides: { "1234567890": "Bản riêng cho Page A" },
    albumOrder: ["asset-1", "asset-2"],
    selectedChannelIds: ["1234567890"],
    shareCaption: true,
    schedule: { mode: "now", value: "" },
    savedAt: "2026-08-17T03:04:05.000Z",
    ...overrides,
  };
}

export interface InMemoryPostDraftRepo extends PostDraftRepo {
  /** Every stored row, for asserting "one row, not two". */
  rows(): { key: string; row: StoredPostDraft }[];
  /** Next call of that method throws this error instead of answering. */
  failNext(method: "load" | "save" | "discard", error: unknown): void;
}

export function makeInMemoryPostDraftRepo(options: { now?: Date } = {}): InMemoryPostDraftRepo {
  const store = new Map<string, StoredPostDraft>();
  const failures = new Map<string, unknown>();
  let tick = 0;
  const base = options.now ?? new Date("2026-08-17T03:00:00.000Z");

  const key = (tenantId: string, ownerUserId: string, kind: string): string =>
    `${tenantId}::${ownerUserId}::${kind}`;

  const throwIfArmed = (method: string): void => {
    if (!failures.has(method)) return;
    const error = failures.get(method);
    failures.delete(method);
    throw error;
  };

  return {
    async load(tenantId, ownerUserId, kind) {
      throwIfArmed("load");
      return store.get(key(tenantId, ownerUserId, kind)) ?? null;
    },
    async save(input: SavePostDraftRecord) {
      throwIfArmed("save");
      tick += 1;
      const row: StoredPostDraft = {
        payload: input.payload,
        schemaVersion: input.schemaVersion,
        updatedAt: new Date(base.getTime() + tick * 1000),
      };
      store.set(key(input.tenantId, input.ownerUserId, input.kind), row);
      return row;
    },
    async discard(tenantId, ownerUserId, kind) {
      throwIfArmed("discard");
      store.delete(key(tenantId, ownerUserId, kind));
    },
    rows() {
      return [...store.entries()].map(([entryKey, row]) => ({ key: entryKey, row }));
    },
    failNext(method, error) {
      failures.set(method, error);
    },
  };
}

/** Seeds a row the repo would never accept through `save` (older/hand-edited). */
export async function seedRawDraft(
  repo: InMemoryPostDraftRepo,
  input: { tenantId: string; ownerUserId: string; kind: string; payload: unknown; schemaVersion?: number },
): Promise<void> {
  await repo.save({
    tenantId: input.tenantId,
    ownerUserId: input.ownerUserId,
    kind: input.kind,
    // The port types `save` with a validated payload; a stored row predating the
    // current shape is exactly what this helper fakes, hence the cast.
    payload: input.payload as ComposeDraftPayload,
    schemaVersion: input.schemaVersion ?? POST_DRAFT_SCHEMA_VERSION,
  });
}

/** An AppError a repo would raise, for "propagates DB_ERROR untouched" tests. */
export function dbOutage(): AppError {
  return new AppError("DB_ERROR", { message: "connection refused" });
}

export interface InMemoryUserRepo extends UserRepo {
  /** Registers "this e-mail is this app_user in this tenant". */
  add(tenantId: string, email: string, userId: string): void;
  /** Next lookup throws this error instead of answering. */
  failNext(error: unknown): void;
  /** Every lookup, to assert an explicit ownerUserId short-circuits it. */
  calls(): { tenantId: string; email: string }[];
}

/**
 * Users the draft usecases resolve an owner against.
 *
 * Case-insensitive on the e-mail, like the port contract requires — that is how
 * a session e-mail in mixed case still finds a lower-cased `app_user.email`.
 */
export function makeInMemoryUserRepo(): InMemoryUserRepo {
  const rows = new Map<string, string>();
  const seen: { tenantId: string; email: string }[] = [];
  let failure: { error: unknown } | null = null;

  const key = (tenantId: string, email: string): string =>
    `${tenantId}::${email.trim().toLowerCase()}`;

  return {
    async findUserIdByEmail(tenantId, email) {
      seen.push({ tenantId, email });
      if (failure) {
        const { error } = failure;
        failure = null;
        throw error;
      }
      return rows.get(key(tenantId, email)) ?? null;
    },
    add(tenantId, email, userId) {
      rows.set(key(tenantId, email), userId);
    },
    failNext(error) {
      failure = { error };
    },
    calls() {
      return [...seen];
    },
  };
}

/**
 * Narrows a draft result to its persisted branch, failing loudly otherwise.
 *
 * Without it every assertion on `updatedAt` would need an inline type guard,
 * and a test that silently read `undefined` off the not-persisted branch would
 * still pass.
 */
export function expectPersisted<T extends { persisted: boolean }>(
  result: T,
): Extract<T, { persisted: true }> {
  if (!result.persisted) {
    throw new Error(`Expected a persisted draft result, got ${JSON.stringify(result)}`);
  }
  return result as Extract<T, { persisted: true }>;
}
