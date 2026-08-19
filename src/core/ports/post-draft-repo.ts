/**
 * Compose draft persistence (E10 — "nháp bài soạn"). Core declares the need;
 * adapters/db implements it. Pure TypeScript: types only (docs/07 §2).
 *
 * Contract for every implementer:
 * - tenant-scoped through the tenant-scope helper (business rule 7); a
 *   missing/invalid tenant id throws AppError('INVALID_INPUT');
 * - a draft is identified by (tenant_id, owner_user_id, kind) — ONE open
 *   compose draft per operator per tenant. `save` MUST upsert on that triple,
 *   never plain-insert: autosave writes every few seconds;
 * - `load` returns null when there is no draft. That is a normal answer, not an
 *   error, and not something to log as a failure;
 * - `discard` on a draft that is not there is a no-op, not an error;
 * - driver failures surface as AppError('DB_ERROR') carrying `tenant_id` and
 *   the operation name; a driver error must never escape raw.
 */

import type { ComposeDraftPayload } from "@/core/domain/post-draft";

export interface StoredPostDraft {
  /**
   * The jsonb column exactly as stored — deliberately `unknown`.
   *
   * A row may predate the current shape or have been edited by hand, so typing
   * it as ComposeDraftPayload here would be a lie the compiler then propagates.
   * `loadPostDraft` runs it through `assertComposeDraftPayload` and decides what
   * an unreadable draft means (answer: "no draft", plus a warn log).
   */
  payload: unknown;
  schemaVersion: number;
  updatedAt: Date;
}

export interface SavePostDraftRecord {
  tenantId: string;
  ownerUserId: string;
  kind: string;
  /** Already validated by the usecase — the repo never sees a raw client body. */
  payload: ComposeDraftPayload;
  schemaVersion: number;
}

export interface PostDraftRepo {
  /** Null when this operator has no draft of that kind. */
  load(tenantId: string, ownerUserId: string, kind: string): Promise<StoredPostDraft | null>;
  /** Upsert on (tenant, owner, kind). Returns the row as written. */
  save(input: SavePostDraftRecord): Promise<StoredPostDraft>;
  discard(tenantId: string, ownerUserId: string, kind: string): Promise<void>;
}
