import { z } from "zod";

/**
 * Contracts of the Google Drive connection block on "Đồng bộ dữ liệu"
 * (`/api/catalog/google/*`).
 *
 * `ui/` may not import `core/` (one-way dependency law, docs/07 §2), so these
 * MIRROR what the API route promises. The runtime parse in `http-client` turns
 * a drift into a loud MALFORMED_RESPONSE instead of a folder tree that silently
 * renders empty — an operator must never pick a folder that is not there.
 */

/** Drive's own id for the top of "My Drive"; the API accepts it as `parentId`. */
export const GOOGLE_DRIVE_ROOT_ID = "root";

/** Shown when the server's breadcrumb is empty (it should never be). */
export const GOOGLE_DRIVE_ROOT_NAME = "Drive của tôi";

/** Error codes this screen has to react to, not just print. */
export const GOOGLE_NOT_CONNECTED_CODE = "GOOGLE_NOT_CONNECTED";
export const GOOGLE_AUTH_EXPIRED_CODE = "GOOGLE_AUTH_EXPIRED";

// --- Can THIS account still read the source already stored? ------------------

/**
 * Answer of the server-side re-check that runs with the connected account's own
 * credentials. It exists because Drive answers "200, no files" — not 403 — for
 * a folder the caller cannot see: without it, a tenant that switches from a
 * Service Account to a personal Google account would run a sync that reads an
 * empty folder and deletes every product and image it has.
 */
export const SOURCE_ACCESS_VALUES = [
  "ok",
  "drive_unreadable",
  "spreadsheet_unreadable",
  "both_unreadable",
  /** Nothing stored yet — there is nothing to be unable to read. */
  "no_source",
  /** The check did not run or could not conclude; NOT a licence to warn. */
  "unknown",
] as const;
export type SourceAccess = (typeof SOURCE_ACCESS_VALUES)[number];

function isSourceAccess(value: string): value is SourceAccess {
  return (SOURCE_ACCESS_VALUES as readonly string[]).includes(value);
}

/**
 * Required on a `connected` payload: a missing key means the server never
 * checked, and this screen would then vouch for a source it knows nothing
 * about. An unrecognised VALUE degrades to `unknown` instead of failing the
 * whole status — a future enum member must not blank the panel the operator
 * needs in order to reconnect.
 */
const sourceAccessField = () =>
  z
    .string()
    .min(1)
    .transform((value): SourceAccess => (isSourceAccess(value) ? value : "unknown"));

// --- Connection status (GET /api/catalog/google/status) ----------------------

/**
 * `expired` is deliberately its OWN state, not a flavour of `not_connected`:
 * a revoked token means syncs are failing right now for a tenant that believes
 * it is configured. Collapsing the two would hide that (business rule 5).
 */
export const GoogleConnectionSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("not_connected") }),
  z.object({
    state: z.literal("connected"),
    email: z.string().min(1),
    /** ISO-8601 from the server; formatted defensively, never parsed twice. */
    connectedAt: z.string().min(1),
    scopes: z.array(z.string()),
    /** Whether the source ALREADY stored is readable by THIS account. */
    sourceAccess: sourceAccessField(),
  }),
  z.object({
    state: z.literal("expired"),
    email: z.string().min(1),
    connectedAt: z.string().min(1),
    /** Server error code, e.g. GOOGLE_AUTH_EXPIRED — shown as a reference. */
    reason: z.string().min(1),
  }),
]);
export type GoogleConnection = z.infer<typeof GoogleConnectionSchema>;
export type GoogleConnectionState = GoogleConnection["state"];

// --- Browser payloads --------------------------------------------------------

export const DriveItemSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
});
export type DriveItem = z.infer<typeof DriveItemSchema>;

/**
 * Absent and `null` mean the same thing here — "this was the last page" — so
 * both are normalised instead of failing the whole page over a missing key.
 */
const pageTokenField = () =>
  z
    .string()
    .nullish()
    .transform((value) => value ?? null);

export const DriveFolderPageSchema = z.object({
  items: z.array(DriveItemSchema),
  nextPageToken: pageTokenField(),
  /** Root first, current folder last. */
  breadcrumb: z.array(DriveItemSchema),
});
export type DriveFolderPage = z.infer<typeof DriveFolderPageSchema>;

export const DriveSpreadsheetPageSchema = z.object({
  items: z.array(DriveItemSchema),
  nextPageToken: pageTokenField(),
});
export type DriveSpreadsheetPage = z.infer<typeof DriveSpreadsheetPageSchema>;

export const SpreadsheetTabsSchema = z.object({
  /** Sheet tab names, in the order they appear in the spreadsheet. */
  tabs: z.array(z.string().min(1)),
});
export type SpreadsheetTabs = z.infer<typeof SpreadsheetTabsSchema>;

// --- OAuth callback (?google=…) ---------------------------------------------

/**
 * What the callback route sent us back to `/sync`. "Người dùng bấm Huỷ" is NOT
 * an error and must not be shown as one (web-auth-methods §4).
 */
export type GoogleConnectOutcome =
  | { kind: "connected" }
  | { kind: "cancelled" }
  | { kind: "error"; reason: string | null };

/** Reason codes are shown as a small reference; keep them printable and short. */
const MAX_REASON_LENGTH = 64;

function safeReason(raw: string | null): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw.trim().replace(/[^A-Za-z0-9_.:-]/g, "");
  if (cleaned.length === 0) return null;
  return cleaned.slice(0, MAX_REASON_LENGTH);
}

/**
 * Query string is user-controlled input — parsed, never trusted. Returns null
 * when the URL carries no callback at all (the normal visit).
 */
export function parseGoogleConnectOutcome(
  params: URLSearchParams | null | undefined,
): GoogleConnectOutcome | null {
  if (!params) return null;

  const google = params.get("google");
  if (google === null) return null;
  if (google === "connected") return { kind: "connected" };
  if (google === "cancelled") return { kind: "cancelled" };
  if (google === "error") return { kind: "error", reason: safeReason(params.get("reason")) };

  // An outcome we do not recognise is still an outcome — never swallowed.
  return { kind: "error", reason: null };
}

/**
 * Vietnamese for the reason codes the callback can carry. The callback puts an
 * `AppError.code` in `reason` and nothing else, so this map holds ONLY codes
 * that route can actually throw — a key for a code that never arrives is dead
 * text nobody will ever see fail. Unknown codes keep their code visible rather
 * than being flattened into "Có lỗi": two different failures must stay tellable
 * apart.
 *
 * Reachable from `GET /api/catalog/google/callback`:
 *  - GOOGLE_CONNECT_STATE_INVALID  state cookie missing / mismatch / no `code`
 *  - GOOGLE_AUTH_EXPIRED           no refresh token, or the grant was revoked
 *  - GOOGLE_OAUTH_NOT_CONFIGURED   the deployment has no OAuth app (invalid_client)
 *  - INVALID_INPUT                 bad tenant id, or Google refused the request
 *  - DRIVE_ERROR                   Google unreachable / answered an odd shape
 *  - DB_ERROR                      consent obtained, storing it failed
 *  - INTERNAL                      anything else (AppError.from fallback)
 * "Người dùng bấm Huỷ" never reaches here — it exits via `?google=cancelled`.
 */
const CONNECT_ERROR_MESSAGES: Record<string, string> = {
  GOOGLE_CONNECT_STATE_INVALID:
    "Phiên kết nối Google đã hết hạn hoặc bị trình duyệt chặn cookie. Bấm “Kết nối Google Drive” để thử lại.",
  [GOOGLE_AUTH_EXPIRED_CODE]:
    "Google không cấp quyền dài hạn cho lần kết nối này, hoặc đã thu hồi quyền của ứng dụng. Vào myaccount.google.com/permissions gỡ quyền của ứng dụng rồi kết nối lại.",
  GOOGLE_OAUTH_NOT_CONFIGURED:
    "Ứng dụng chưa được cấu hình OAuth với Google. Báo quản trị hệ thống.",
  INVALID_INPUT:
    "Yêu cầu kết nối không hợp lệ (thiếu hoặc sai mã đơn vị). Hãy mở lại màn Đồng bộ dữ liệu rồi bấm kết nối.",
  DRIVE_ERROR:
    "Không liên lạc được với Google khi hoàn tất kết nối. Hãy thử kết nối lại sau ít phút.",
  // Consent succeeded, storing it did not: without this line the screen would
  // just say "chưa kết nối" right after sending the operator to Google.
  DB_ERROR:
    "Đã lấy được quyền từ Google nhưng chưa lưu được kết nối. Hãy thử kết nối lại; nếu vẫn lỗi, báo quản trị hệ thống.",
  INTERNAL:
    "Hệ thống gặp sự cố khi hoàn tất kết nối Google. Hãy thử lại; nếu vẫn lỗi, báo quản trị hệ thống kèm mã bên dưới.",
};

export function googleConnectErrorMessage(reason: string | null): string {
  if (reason === null) {
    return "Không hoàn tất được kết nối Google. Hãy thử kết nối lại; nếu vẫn lỗi, báo quản trị viên.";
  }
  return (
    CONNECT_ERROR_MESSAGES[reason] ??
    "Không hoàn tất được kết nối Google. Hãy thử kết nối lại; nếu vẫn lỗi, báo quản trị viên kèm mã bên dưới."
  );
}

// --- Display helpers ---------------------------------------------------------

/** A Drive file may have a blank name; an empty row would be unclickable. */
export function driveItemLabel(item: DriveItem): string {
  const trimmed = item.name.trim();
  return trimmed.length > 0 ? trimmed : "(không có tên)";
}

/**
 * "19/08/2026 10:00". Returns null for anything unparseable — a broken date is
 * worth dropping, not worth breaking the panel that explains the connection.
 */
export function formatConnectedAt(iso: string): string | null {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  return at.toLocaleString("vi-VN", { dateStyle: "short", timeStyle: "short" });
}

/**
 * What to say when the connected account cannot read the source already stored.
 * Wording lives next to the contract so it stays testable without rendering.
 */
export interface SourceAccessWarning {
  title: string;
  message: string;
  /** The one way out: pick the source again with the account now in use. */
  actionLabel: string;
}

export function sourceAccessWarning(access: SourceAccess): SourceAccessWarning | null {
  // `no_source` (nothing stored yet) and `unknown` (the check did not conclude)
  // are not problems to report. Warning on either teaches the operator to skip
  // the box that does matter.
  if (access === "ok" || access === "no_source" || access === "unknown") return null;

  const what =
    access === "drive_unreadable"
      ? "thư mục ảnh đang lưu"
      : access === "spreadsheet_unreadable"
        ? "bảng Google Sheet đang lưu"
        : "thư mục ảnh và bảng Google Sheet đang lưu";

  const fix =
    access === "drive_unreadable"
      ? "hãy chọn lại thư mục, hoặc chia sẻ thư mục đó cho tài khoản này"
      : access === "spreadsheet_unreadable"
        ? "hãy chọn lại bảng, hoặc chia sẻ bảng đó cho tài khoản này"
        : "hãy chọn lại cả thư mục và bảng, hoặc chia sẻ cả hai cho tài khoản này";

  return {
    title: "Nguồn đang lưu không đọc được bằng tài khoản vừa kết nối",
    message: `Tài khoản Google vừa kết nối không đọc được ${what}. Đồng bộ sẽ dừng để tránh xoá nhầm sản phẩm và ảnh — ${fix}.`,
    actionLabel: "Chọn lại thư mục và bảng",
  };
}

/** Last crumb = the folder currently being listed. */
export function currentFolder(breadcrumb: readonly DriveItem[]): DriveItem {
  return breadcrumb.at(-1) ?? { id: GOOGLE_DRIVE_ROOT_ID, name: GOOGLE_DRIVE_ROOT_NAME };
}
