import type { TenantId } from "@/core/domain/tenant-context";
/**
 * Google Drive OAuth port (E2 — "Kết nối Google Drive" on the sync screen).
 * Core declares the need; adapters/google + adapters/db implement it.
 * Types only — no runtime import (docs/07 section 2).
 *
 * SECRETS: the refresh token exists in exactly TWO places of this contract —
 * `GoogleOAuthTokens.refreshToken` (straight out of the token endpoint) and
 * `GoogleOAuthRepo.findRefreshToken` (straight into the auth resolver). It is
 * never part of a view type, never returned by an API route, never logged.
 *
 * Contract for implementers:
 * - Every answer of Google is schema-validated in the adapter before it becomes
 *   one of these values.
 * - A revoked/expired refresh token surfaces as AppError('GOOGLE_AUTH_EXPIRED')
 *   with `tenant_id` in the context — never as an empty listing, because the
 *   catalog sync reads "no file" as "everything was deleted".
 * - Anything else Drive/Sheets rejects stays DRIVE_ERROR / SHEET_ERROR.
 */

/**
 * Can the CURRENTLY connected Google account actually read the Drive folder and
 * the spreadsheet this tenant is configured with?
 *
 * It exists because connecting an account and choosing a source are two
 * independent actions: a tenant that used to run on the Service Account can
 * connect a personal account that sees the sheet but not the photo folder, and
 * Drive reports that as an empty folder rather than as a permission error.
 *
 * Stored, never recomputed on read: the sync screen polls, and a Drive/Sheets
 * call per poll would burn quota for an answer that only changes when somebody
 * connects an account or picks another source.
 */
export const GOOGLE_SOURCE_ACCESS_STATES = [
  "ok",
  "drive_unreadable",
  "spreadsheet_unreadable",
  "both_unreadable",
  /** The tenant has no source configured yet — nothing to check. */
  "no_source",
  /** Never checked, or the check itself failed (network/quota). Not a verdict. */
  "unknown",
] as const;

export type GoogleSourceAccessState = (typeof GOOGLE_SOURCE_ACCESS_STATES)[number];

export interface GoogleSourceAccess {
  readonly state: GoogleSourceAccessState;
  /** ISO-8601 of the check that produced `state`. */
  readonly checkedAt: string;
}

/** What the sync screen may see about a connection. No token, ever. */
export interface GoogleOAuthConnection {
  /** Google account the tenant connected, e.g. `shop@gmail.com`. */
  readonly email: string;
  /** Scopes Google actually granted (it may grant fewer than we asked). */
  readonly scopes: readonly string[];
  /** ISO-8601, as stored at connect time. */
  readonly connectedAt: string;
  /** `app_user.id` of whoever pressed the button, or null when unknown. */
  readonly connectedByUserId: string | null;
  /**
   * Mirrors `tenant_integration.status`: `error` means the refresh token was
   * rejected, i.e. the screen must ask for a reconnect.
   */
  readonly status: "active" | "error";
  /**
   * Result of the last source-access check, or null when none ever ran (an old
   * connection, or one made before this check existed). Null reads as
   * `"unknown"` on the screen — it is not a clean bill of health.
   */
  readonly sourceAccess: GoogleSourceAccess | null;
}

/** Fresh result of the code exchange. SECRET. */
export interface GoogleOAuthTokens {
  readonly refreshToken: string;
  readonly email: string;
  readonly scopes: readonly string[];
}

export interface SaveGoogleConnectionInput {
  readonly tenantId: TenantId;
  /** SECRET — implementers MUST seal it before it touches the database. */
  readonly refreshToken: string;
  readonly email: string;
  readonly scopes: readonly string[];
  readonly connectedAt: string;
  readonly actorUserId: string | null;
  /** Kept in the audit payload even when the id is unknown. */
  readonly actorEmail: string | null;
}

export interface DeleteGoogleConnectionInput {
  readonly tenantId: TenantId;
  readonly actorUserId: string | null;
  readonly actorEmail: string | null;
}

export interface GoogleOAuthRepo {
  /** Null when the tenant never connected (or already disconnected). */
  findConnection(tenantId: TenantId): Promise<GoogleOAuthConnection | null>;
  /**
   * SECRET. Only the auth resolver may call this. Null = no connection, which
   * means "fall back to the Service Account", not "fail".
   */
  findRefreshToken(tenantId: TenantId): Promise<string | null>;
  /**
   * Writes (or replaces) the oauth part of `tenant_integration.config`, KEEPING
   * every other key of the blob, and writes the audit row in the SAME
   * transaction. Revives a row parked in `error` — a fresh consent is exactly
   * the operator action that marker was asking for.
   */
  saveConnection(input: SaveGoogleConnectionInput): Promise<void>;
  /**
   * Removes the oauth part (and nothing else) + audit row, in one transaction.
   * Returns false when there was nothing to remove, so the caller can stay
   * idempotent instead of inventing an error.
   */
  deleteConnection(input: DeleteGoogleConnectionInput): Promise<{ readonly removed: boolean }>;
  /**
   * Marks the integration unusable after Google rejected the refresh token.
   * Never throws over a missing row: this runs on an error path already.
   *
   * Implementers MUST NOT park a row that carries no connection any more: a
   * tenant who just pressed "Ngắt kết nối" is `not_connected`, not `expired`.
   */
  markConnectionExpired(tenantId: TenantId, reason: string): Promise<void>;
  /**
   * Records the verdict of the last source-access check inside the oauth blob.
   * A no-op when the tenant has no connection: the key only ever describes a
   * connected account, and inventing one for a Service Account tenant would put
   * a warning on a screen with nothing to fix.
   */
  saveSourceAccess(input: SaveGoogleSourceAccessInput): Promise<void>;
}

export interface SaveGoogleSourceAccessInput {
  readonly tenantId: TenantId;
  readonly state: GoogleSourceAccessState;
  readonly checkedAt: string;
}

export interface BuildGoogleAuthorizeUrlInput {
  /** CSRF nonce; the route stores it in an httpOnly cookie and re-checks it. */
  readonly state: string;
}

export interface ExchangeGoogleCodeInput {
  readonly code: string;
}

export interface GoogleOAuthClient {
  buildAuthorizeUrl(input: BuildGoogleAuthorizeUrlInput): string;
  exchangeCode(input: ExchangeGoogleCodeInput): Promise<GoogleOAuthTokens>;
  /**
   * Best-effort revoke at Google. Implementers throw on failure; the caller
   * logs a warning and disconnects locally anyway — a token we cannot revoke
   * must not keep a stale connection alive on the screen.
   */
  revoke(input: { readonly refreshToken: string }): Promise<void>;
}

/**
 * In-process cache of the per-tenant auth clients. Core only ever INVALIDATES:
 * a connect or a disconnect must not leave the next Drive call using the
 * previous account's token.
 */
export interface GoogleAuthCache {
  invalidate(tenantId: TenantId): void;
}

// --- Drive browser (the in-app folder picker) --------------------------------

/** One row of the picker: a folder or a spreadsheet. */
export interface GoogleDriveEntry {
  readonly id: string;
  readonly name: string;
}

export interface ListGoogleFoldersInput {
  readonly tenantId: TenantId;
  /** `root` = "Drive của tôi"; anything else is a folder id. */
  readonly parentId: string;
  readonly pageToken?: string | null;
  /** Free-text filter on the name. May legitimately contain a quote. */
  readonly q?: string | null;
}

export interface ListGoogleFoldersResult {
  readonly items: readonly GoogleDriveEntry[];
  readonly nextPageToken: string | null;
  /** Path from root to `parentId`, root first. Never empty. */
  readonly breadcrumb: readonly GoogleDriveEntry[];
}

export interface ListGoogleSpreadsheetsInput {
  readonly tenantId: TenantId;
  /** Absent/null = search the whole Drive, most recently modified first. */
  readonly parentId?: string | null;
  readonly pageToken?: string | null;
  readonly q?: string | null;
}

export interface ListGoogleSpreadsheetsResult {
  readonly items: readonly GoogleDriveEntry[];
  readonly nextPageToken: string | null;
}

export interface ListGoogleSheetTabsInput {
  readonly tenantId: TenantId;
  readonly spreadsheetId: string;
}

export interface CheckGoogleSourceAccessInput {
  readonly tenantId: TenantId;
  /** Null/empty = not configured; that half of the check is skipped. */
  readonly driveFolderId: string | null;
  readonly spreadsheetId: string | null;
}

export interface GoogleDriveBrowser {
  listFolders(input: ListGoogleFoldersInput): Promise<ListGoogleFoldersResult>;
  listSpreadsheets(input: ListGoogleSpreadsheetsInput): Promise<ListGoogleSpreadsheetsResult>;
  /** Tab names of one spreadsheet, in sheet order. */
  listSheetTabs(input: ListGoogleSheetTabsInput): Promise<readonly string[]>;
  /**
   * Probes the CONFIGURED source with the identity currently in use —
   * `files.get` + `spreadsheets.get`, which answer 403/404 when the account
   * cannot see the object (`files.list` would answer 200 with an empty list and
   * tell us nothing).
   *
   * Never throws for a permission answer: "không đọc được" IS the result. Only
   * an inconclusive check (network, quota, expired grant) becomes `"unknown"`,
   * because claiming `"ok"` there would be a lie the next sync pays for.
   */
  checkSourceAccess(input: CheckGoogleSourceAccessInput): Promise<GoogleSourceAccessState>;
}
