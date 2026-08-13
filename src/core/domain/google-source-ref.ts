import { AppError } from "./errors";

/**
 * "Dán link hay dán ID?" — both, for the Drive folder and the Sheet.
 *
 * An operator copies the address bar; a developer pastes the raw id. Pure
 * functions, no I/O: the id is only extracted and shape-checked here, whether it
 * really exists is Google's answer at the next sync.
 *
 * Deliberately strict about the host: a Dropbox link or a shortened URL that
 * "looks like" a folder must fail loudly at paste time. Silently storing it
 * would surface hours later as an empty sync nobody can explain.
 */

/** Google file/folder ids are base64url-ish and never short. */
const ID_PATTERN = /^[A-Za-z0-9_-]{10,}$/;

export const GOOGLE_REF_KINDS = ["drive_folder", "spreadsheet"] as const;
export type GoogleRefKind = (typeof GOOGLE_REF_KINDS)[number];

export const GOOGLE_REF_REJECTIONS = [
  "EMPTY",
  "NOT_A_URL_OR_ID",
  "WRONG_HOST",
  "WRONG_PATH",
  "PUBLISHED_LINK",
  "MALFORMED_ID",
] as const;
export type GoogleRefRejection = (typeof GOOGLE_REF_REJECTIONS)[number];

export type GoogleRefResult =
  | { readonly ok: true; readonly id: string }
  | { readonly ok: false; readonly reason: GoogleRefRejection };

const DRIVE_HOSTS = new Set(["drive.google.com"]);
const SHEET_HOSTS = new Set(["docs.google.com"]);

/**
 * Accepts:
 *   https://drive.google.com/drive/folders/<id>?usp=sharing#anything
 *   https://drive.google.com/drive/u/0/folders/<id>
 *   https://drive.google.com/open?id=<id>
 *   <id>
 */
export function parseDriveFolderRef(raw: unknown): GoogleRefResult {
  const value = str(raw);
  if (value.length === 0) return reject("EMPTY");

  if (!looksLikeUrl(value)) return bareId(value);
  const url = toUrl(value);
  if (!url) return reject("NOT_A_URL_OR_ID");
  if (!DRIVE_HOSTS.has(url.hostname.toLowerCase())) return reject("WRONG_HOST");

  const segments = pathSegments(url);
  const folderIndex = segments.lastIndexOf("folders");
  if (folderIndex >= 0) return bareId(segments[folderIndex + 1] ?? "");

  // The legacy "open?id=" form is still what some share dialogs produce.
  const queryId = url.searchParams.get("id");
  if (typeof queryId === "string" && queryId.length > 0) return bareId(queryId);

  return reject("WRONG_PATH");
}

/**
 * Accepts:
 *   https://docs.google.com/spreadsheets/d/<id>/edit#gid=0
 *   https://docs.google.com/spreadsheets/d/<id>
 *   <id>
 *
 * Rejects the "published to the web" form (`/spreadsheets/d/e/<token>`): that
 * token is NOT the spreadsheet id and the Sheets API cannot read it.
 */
export function parseSpreadsheetRef(raw: unknown): GoogleRefResult {
  const value = str(raw);
  if (value.length === 0) return reject("EMPTY");

  if (!looksLikeUrl(value)) return bareId(value);
  const url = toUrl(value);
  if (!url) return reject("NOT_A_URL_OR_ID");
  if (!SHEET_HOSTS.has(url.hostname.toLowerCase())) return reject("WRONG_HOST");

  const segments = pathSegments(url);
  if (segments[0] !== "spreadsheets") return reject("WRONG_PATH");

  const dIndex = segments.indexOf("d");
  if (dIndex < 0) return reject("WRONG_PATH");
  const next = segments[dIndex + 1] ?? "";
  if (next === "e") return reject("PUBLISHED_LINK");
  return bareId(next);
}

/** Vietnamese, shown next to the field the operator just pasted into. */
const USER_MESSAGES: Readonly<Record<GoogleRefKind, string>> = {
  drive_folder: "Dán link folder Google Drive hoặc ID của nó",
  spreadsheet: "Dán link Google Sheet hoặc ID của nó",
};

const REASON_HINTS: Readonly<Record<GoogleRefRejection, string>> = {
  EMPTY: "Chưa nhập gì",
  NOT_A_URL_OR_ID: "Chuỗi này không phải link hợp lệ cũng không phải ID",
  WRONG_HOST: "Link không thuộc Google",
  WRONG_PATH: "Link Google này không trỏ tới đúng loại tài nguyên",
  PUBLISHED_LINK: "Đây là link 'đã xuất bản', không phải link file — mở file rồi copy link trên thanh địa chỉ",
  MALFORMED_ID: "ID không đúng định dạng",
};

/**
 * Parses or throws INVALID_INPUT naming the field. The thin wrapper exists so
 * every caller reports the same message for the same mistake.
 */
export function requireGoogleRef(kind: GoogleRefKind, field: string, raw: unknown): string {
  const result = kind === "drive_folder" ? parseDriveFolderRef(raw) : parseSpreadsheetRef(raw);
  if (result.ok) return result.id;

  const userMessage = `${USER_MESSAGES[kind]}. ${REASON_HINTS[result.reason]}.`;
  throw new AppError("INVALID_INPUT", {
    message: `${field} is not a usable Google ${kind} reference (${result.reason})`,
    userMessage,
    // `issues` mirrors the zod shape extractIssues() reads, so the API response
    // carries a field-addressed entry and the form can place it inline.
    context: { field, reason: result.reason, issues: [{ path: field, message: userMessage }] },
  });
}

// --- helpers ----------------------------------------------------------------

function bareId(candidate: string): GoogleRefResult {
  const id = str(candidate);
  if (id.length === 0) return reject("WRONG_PATH");
  return ID_PATTERN.test(id) ? { ok: true, id } : reject("MALFORMED_ID");
}

/** A scheme means the operator meant a link; a bare id never carries one. */
function looksLikeUrl(value: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value);
}

/** Null when the string carries a scheme but is not a usable http(s) URL. */
function toUrl(value: string): URL | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    // Not swallowing an error: a non-parsable URL is a VALUE here, and the
    // caller turns the rejection into INVALID_INPUT with the field name.
    return null;
  }
  return url.protocol === "http:" || url.protocol === "https:" ? url : null;
}

function pathSegments(url: URL): string[] {
  return url.pathname
    .split("/")
    .map((segment) => decodeURIComponent(segment).trim())
    .filter((segment) => segment.length > 0);
}

function reject(reason: GoogleRefRejection): GoogleRefResult {
  return { ok: false, reason };
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
