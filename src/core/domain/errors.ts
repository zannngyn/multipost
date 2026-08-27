/**
 * AppError — the single error type crossing every layer boundary.
 * Pure TypeScript: no imports, no I/O (see docs/07 section 2).
 *
 * Layers add their own codes here as features land. Never throw raw strings
 * or bare Error for business failures.
 */

export const ERROR_CODES = [
  "INVALID_INPUT",
  "INTERNAL",
  "TENANT_NOT_FOUND",
  "UNAUTHORIZED",
  "DB_ERROR",
  "QUEUE_ERROR",
  // Access registry (E1.4 — allow-list in the database + approval screen)
  /** The signed-in operator may not perform this administrative action. */
  "ACCESS_FORBIDDEN",
  /** No access request with that id in this tenant. */
  "ACCESS_REQUEST_NOT_FOUND",
  // Multi-tenant session (M1.2, doc 10 §3)
  /**
   * Signed in, but no tenant is selected (no cookie and more than one — or
   * zero — membership). NOT an error of the operator: the UI answers with the
   * tenant picker (state NoMembership / chưa chọn, docs/09 §3.8).
   */
  "TENANT_NOT_SELECTED",
  // Onboarding (M2.1/M2.2 — self-service tenants + invite links)
  /** The account hit the self-service creation cap (lifetime or per-hour). */
  "TENANT_LIMIT_REACHED",
  /** The requested slug already names another tenant. */
  "SLUG_TAKEN",
  /**
   * We ran out of tries deriving a FREE slug for a name the operator did not
   * slug themselves (every default company derives the same base slug). Its own
   * code, not SLUG_TAKEN: nobody chose that slug, so "pick another one" would be
   * nonsense — and at the entropy we retry with, seeing this means something is
   * systemically wrong, not that a name is popular.
   */
  "SLUG_DERIVATION_EXHAUSTED",
  /**
   * ONE code for every invite refusal — unknown, expired, revoked, used up,
   * suspended tenant. Deliberately indistinguishable outside (anti-probing);
   * the precise reason goes to the log.
   */
  "INVITE_INVALID",
  /** The inviter's role may not grant the requested role (doc 10 §4.4 ladder). */
  "INVITE_ROLE_FORBIDDEN",
  // Members (M2.3) + retirement (M2.4)
  /** The change would leave the company without a single active owner. */
  "LAST_OWNER",
  /** No membership with that id in this tenant — behaves as absent (doc 10 §3). */
  "MEMBER_NOT_FOUND",
  /**
   * The endpoint was retired by a milestone and answers 410 Gone. Its own code
   * (not INVALID_INPUT) so an old UI shows "tính năng đã thay đổi", not "dữ
   * liệu không hợp lệ" — and so retired surfaces stay greppable as a family.
   */
  "RETIRED",
  /**
   * Has a membership in the tenant but lacks the required role. Deliberately
   * distinct from 404 (no membership = resource does not exist for you) and
   * from ACCESS_FORBIDDEN (the legacy /access screen gate, retiring at M2.4).
   */
  "FORBIDDEN",
  // Password sign-in / sign-up (email + password, docs/09 §3.1)
  /** The chosen password breaks the shared policy (shared/password-policy). */
  "AUTH_WEAK_PASSWORD",
  /** Sign-up: a credential already exists for this address. */
  "AUTH_EMAIL_TAKEN",
  /**
   * ONE code for EVERY sign-in refusal — unknown address, wrong password,
   * suspended account, malformed input. Deliberately indistinguishable outside
   * (anti-enumeration, same discipline as INVITE_INVALID); the precise reason
   * goes to the log.
   */
  "AUTH_INVALID_CREDENTIALS",
  /** Too many consecutive failures: refused until `locked_until` passes. */
  "AUTH_ACCOUNT_LOCKED",
  /** Sliding-window limiter said no (per-IP or per-address) before any hashing. */
  "AUTH_RATE_LIMITED",
  /** Admin reset asked for an account that signs in some other way. */
  "AUTH_CREDENTIAL_NOT_FOUND",
  "JOB_PAYLOAD_INVALID",
  // Data pipeline (E2/E3)
  "DRIVE_ERROR",
  "SHEET_ERROR",
  "FILE_NAME_INVALID",
  "SHEET_ROW_INVALID",
  "PRODUCT_NOT_FOUND",
  "MEDIA_NOT_FOUND",
  "OUT_OF_STOCK",
  "SYNC_FAILED",
  /**
   * A sync was STOPPED because the source came back empty while the database
   * still holds rows — the shape a lost permission takes (Drive answers 200
   * with `files: []`, it does not answer 403). Deleting here would be data loss.
   */
  "SYNC_SOURCE_EMPTY",
  // Google Drive OAuth (E2 — "Kết nối Google Drive" on the sync screen)
  /** The tenant never connected a Google account (or disconnected it). */
  "GOOGLE_NOT_CONNECTED",
  /** The stored refresh token was revoked/expired — reconnect is the only fix. */
  "GOOGLE_AUTH_EXPIRED",
  /** The deployment itself has no Google OAuth app configured (env missing). */
  "GOOGLE_OAUTH_NOT_CONFIGURED",
  /**
   * The OAuth callback could not be trusted: no state cookie, a state that does
   * not match, or no authorization code. Its own code (not INVALID_INPUT) so the
   * screen can say "bấm kết nối lại" instead of "dữ liệu gửi lên không hợp lệ".
   */
  "GOOGLE_CONNECT_STATE_INVALID",
  // AI gateway (E4, ADR-001)
  "AI_PROVIDER_ERROR",
  "AI_RESPONSE_INVALID",
  "AI_RATE_LIMITED",
  "AI_BUDGET_EXCEEDED",
  "CAPTION_VALIDATION_FAILED",
  "MODEL_NOT_CONFIGURED",
  "PROMPT_NOT_FOUND",
  /** Activating a prompt version that does not exist — caller input, not a broken catalog (doc 10 B3). */
  "PROMPT_VERSION_NOT_FOUND",
  // Publishing (E5/E7)
  /** Batch id this tenant does not own — behaves as "does not exist" (doc 10 §3, B5). */
  "BATCH_NOT_FOUND",
  /** Channel group id this tenant does not own (doc 10 B5). */
  "CHANNEL_GROUP_NOT_FOUND",
  "META_ERROR",
  "TOKEN_EXPIRED",
  /** An upload URL the platform handed us points somewhere we will not send a token. */
  "UPLOAD_HOST_NOT_ALLOWED",
  "CHANNEL_NOT_CONFIGURED",
  "DUPLICATE_POST_BLOCKED",
  "PUBLISH_FAILED",
  "INVALID_JOB_TRANSITION",
  // Compose draft (E10 — server-side draft of the compose screen)
  /** The draft payload carries a forbidden key or does not match the shape. */
  "DRAFT_PAYLOAD_REJECTED",
  /** The draft payload is over POST_DRAFT_MAX_BYTES. */
  "DRAFT_TOO_LARGE",
  // Video (E2/E3 Phase 2)
  "VIDEO_SPEC_INVALID",
  "VIDEO_PROBE_FAILED",
  "TIKTOK_ERROR",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** Structured context for logs. Keep it serialisable — never put secrets here. */
export type ErrorContext = Readonly<Record<string, unknown>>;

/** Vietnamese message shown to operators. Every code MUST have one. */
const DEFAULT_USER_MESSAGES: Record<ErrorCode, string> = {
  INVALID_INPUT: "Dữ liệu gửi lên không hợp lệ. Vui lòng kiểm tra lại.",
  INTERNAL: "Hệ thống gặp sự cố. Vui lòng thử lại sau ít phút.",
  TENANT_NOT_FOUND: "Không tìm thấy đơn vị (tenant) tương ứng.",
  UNAUTHORIZED: "Phiên đăng nhập không hợp lệ hoặc đã hết hạn. Vui lòng đăng nhập lại.",
  DB_ERROR: "Không truy cập được cơ sở dữ liệu. Vui lòng thử lại sau ít phút.",
  QUEUE_ERROR: "Hàng đợi công việc gặp sự cố. Vui lòng thử lại sau ít phút.",
  ACCESS_FORBIDDEN: "Tài khoản của bạn không có quyền thực hiện thao tác này.",
  ACCESS_REQUEST_NOT_FOUND: "Không tìm thấy yêu cầu truy cập tương ứng.",
  TENANT_NOT_SELECTED: "Bạn chưa chọn công ty làm việc. Hãy chọn một công ty để tiếp tục.",
  TENANT_LIMIT_REACHED:
    "Bạn đã chạm giới hạn tạo công ty (tối đa 3 công ty, và không quá 1 công ty mỗi giờ). Liên hệ quản trị viên nếu cần thêm.",
  SLUG_TAKEN: "Định danh (slug) này đã có công ty khác dùng. Hãy chọn một định danh khác.",
  SLUG_DERIVATION_EXHAUSTED:
    "Hệ thống chưa tạo được định danh (slug) cho công ty này. Vui lòng thử lại sau ít phút.",
  INVITE_INVALID: "Link mời không hợp lệ hoặc đã hết hạn. Hãy xin link mời mới.",
  INVITE_ROLE_FORBIDDEN: "Vai trò của bạn không được phép mời tới vai trò này.",
  LAST_OWNER: "Công ty phải còn ít nhất một owner — chuyển quyền trước.",
  MEMBER_NOT_FOUND: "Không tìm thấy thành viên tương ứng trong công ty.",
  RETIRED: "Tính năng này đã thay đổi — thành viên mới vào công ty bằng link mời.",
  FORBIDDEN: "Vai trò của bạn trong công ty này không đủ quyền thực hiện thao tác.",
  AUTH_WEAK_PASSWORD: "Mật khẩu chưa đủ mạnh. Vui lòng chọn mật khẩu khác.",
  AUTH_EMAIL_TAKEN: "Email này đã được đăng ký. Hãy đăng nhập, hoặc dùng email khác.",
  AUTH_INVALID_CREDENTIALS: "Email hoặc mật khẩu không đúng.",
  AUTH_ACCOUNT_LOCKED:
    "Tài khoản đang tạm khoá do nhập sai mật khẩu nhiều lần. Vui lòng thử lại sau ít phút.",
  AUTH_RATE_LIMITED: "Bạn thử quá nhiều lần. Vui lòng chờ ít phút rồi thử lại.",
  AUTH_CREDENTIAL_NOT_FOUND:
    "Tài khoản này không đăng nhập bằng mật khẩu — không có mật khẩu để đặt lại.",
  JOB_PAYLOAD_INVALID: "Dữ liệu công việc nền không hợp lệ — công việc đã bị từ chối.",
  DRIVE_ERROR: "Không truy cập được Google Drive. Kiểm tra quyền Service Account hoặc thử lại sau.",
  SHEET_ERROR: "Không đọc được Google Sheet. Kiểm tra quyền Service Account hoặc thử lại sau.",
  FILE_NAME_INVALID: "Tên file ảnh/video không đúng chuẩn đặt tên — file bị bỏ qua và đã ghi nhận.",
  SHEET_ROW_INVALID: "Dòng dữ liệu trong bảng dữ liệu không hợp lệ — đã ghi nhận để rà soát.",
  PRODUCT_NOT_FOUND: "Không tìm thấy sản phẩm với mã tương ứng trong dữ liệu sản phẩm.",
  MEDIA_NOT_FOUND: "Không tìm thấy ảnh/video cho sản phẩm này trên Drive.",
  OUT_OF_STOCK: "Sản phẩm đã hết hàng hoặc tồn kho không hợp lệ — bài đăng bị chặn.",
  SYNC_FAILED: "Đồng bộ dữ liệu từ Drive/Sheet thất bại. Xem nhật ký đồng bộ để biết chi tiết.",
  SYNC_SOURCE_EMPTY:
    "Nguồn Drive/Sheet không trả về dữ liệu nào trong khi hệ thống đang lưu dữ liệu cũ. Đã dừng đồng bộ để không xoá nhầm — kiểm tra quyền truy cập, hoặc chọn lại nguồn.",
  GOOGLE_NOT_CONNECTED:
    "Đơn vị chưa kết nối tài khoản Google. Vào màn Đồng bộ dữ liệu, bấm “Kết nối Google Drive”.",
  GOOGLE_AUTH_EXPIRED:
    "Kết nối Google của đơn vị đã hết hạn hoặc bị thu hồi. Vào màn Đồng bộ dữ liệu kết nối lại.",
  GOOGLE_OAUTH_NOT_CONFIGURED:
    "Hệ thống chưa cấu hình ứng dụng Google OAuth. Vui lòng liên hệ quản trị viên.",
  GOOGLE_CONNECT_STATE_INVALID:
    "Phiên kết nối Google đã hết hạn hoặc bị chặn cookie — hãy bấm “Kết nối Google Drive” lại.",
  AI_PROVIDER_ERROR: "Dịch vụ AI gặp sự cố. Hệ thống sẽ thử nhà cung cấp dự phòng.",
  AI_RESPONSE_INVALID: "Kết quả AI trả về không đúng định dạng — đã từ chối và ghi nhận.",
  AI_RATE_LIMITED: "Dịch vụ AI đang bị giới hạn tần suất. Vui lòng thử lại sau ít phút.",
  AI_BUDGET_EXCEEDED: "Đã chạm ngưỡng chi phí AI được cấu hình. Cần quản trị viên xem xét.",
  CAPTION_VALIDATION_FAILED: "Caption không qua được bước kiểm tra an toàn — cần chỉnh sửa hoặc tạo lại.",
  MODEL_NOT_CONFIGURED: "Chưa cấu hình model AI cho tác vụ này. Kiểm tra registry model.",
  PROMPT_NOT_FOUND: "Không tìm thấy prompt template cho tác vụ này.",
  PROMPT_VERSION_NOT_FOUND: "Không tìm thấy phiên bản prompt này.",
  BATCH_NOT_FOUND: "Không tìm thấy lô đăng bài này.",
  CHANNEL_GROUP_NOT_FOUND: "Không tìm thấy nhóm kênh này.",
  META_ERROR: "Facebook trả về lỗi khi đăng bài. Xem chi tiết trong nhật ký đăng.",
  TOKEN_EXPIRED: "Token của kênh đã hết hạn hoặc bị thu hồi. Cần kết nối lại kênh.",
  UPLOAD_HOST_NOT_ALLOWED:
    "Facebook trả về địa chỉ tải lên không hợp lệ — đã dừng để không gửi token đi nơi khác.",
  CHANNEL_NOT_CONFIGURED: "Kênh chưa được cấu hình cho đơn vị này. Kiểm tra phần quản lý kênh.",
  DUPLICATE_POST_BLOCKED: "Bài này đã được đăng (hoặc đang đăng) lên kênh này — đã chặn đăng trùng.",
  PUBLISH_FAILED: "Đăng bài thất bại sau số lần thử cho phép. Xem nhật ký để biết nguyên nhân.",
  INVALID_JOB_TRANSITION: "Trạng thái công việc đăng bài không cho phép thao tác này.",
  DRAFT_PAYLOAD_REJECTED:
    "Bản nháp chứa dữ liệu không được phép lưu — hệ thống đã từ chối để tránh lộ dữ liệu nội bộ.",
  DRAFT_TOO_LARGE: "Bản nháp quá lớn để lưu trên máy chủ. Hãy rút gọn nội dung rồi thử lại.",
  VIDEO_SPEC_INVALID: "Video chưa đạt thông số của kênh — bài đăng bị chặn.",
  VIDEO_PROBE_FAILED: "Không kiểm tra được thông số video. Xem nhật ký để biết chi tiết.",
  TIKTOK_ERROR: "TikTok trả về lỗi khi đăng bài. Xem chi tiết trong nhật ký đăng.",
};

/** English developer message. Falls back to the code itself. */
const DEFAULT_MESSAGES: Record<ErrorCode, string> = {
  INVALID_INPUT: "Request payload failed schema validation",
  INTERNAL: "Unexpected internal error",
  TENANT_NOT_FOUND: "Tenant not found",
  UNAUTHORIZED: "Missing or invalid credentials",
  DB_ERROR: "Database operation failed",
  QUEUE_ERROR: "Job queue operation failed",
  ACCESS_FORBIDDEN: "Operator is not allowed to perform this administrative action",
  ACCESS_REQUEST_NOT_FOUND: "Access request not found in this tenant",
  TENANT_NOT_SELECTED: "Signed-in account has not selected an active tenant",
  TENANT_LIMIT_REACHED: "Self-service tenant creation limit reached for this account",
  SLUG_TAKEN: "Another tenant already uses this slug",
  SLUG_DERIVATION_EXHAUSTED: "Ran out of attempts deriving an unused tenant slug",
  INVITE_INVALID: "Invite token is unknown, expired, revoked or used up",
  INVITE_ROLE_FORBIDDEN: "Inviter's role may not grant the requested role",
  LAST_OWNER: "Change would leave the tenant with zero active owners",
  MEMBER_NOT_FOUND: "No membership with that id in this tenant",
  RETIRED: "Endpoint retired — members join through invite links",
  FORBIDDEN: "Membership role is below the required role for this action",
  AUTH_WEAK_PASSWORD: "Password does not satisfy the password policy",
  AUTH_EMAIL_TAKEN: "A credential already exists for this e-mail address",
  AUTH_INVALID_CREDENTIALS: "E-mail/password sign-in refused",
  AUTH_ACCOUNT_LOCKED: "Credential is locked after consecutive failed attempts",
  AUTH_RATE_LIMITED: "Authentication rate limit exceeded",
  AUTH_CREDENTIAL_NOT_FOUND: "Account has no password credential",
  JOB_PAYLOAD_INVALID: "Job payload failed schema validation",
  DRIVE_ERROR: "Google Drive operation failed",
  SHEET_ERROR: "Google Sheets operation failed",
  FILE_NAME_INVALID: "Media file name does not match the naming convention",
  SHEET_ROW_INVALID: "Sheet row failed schema validation",
  // "catalog", not "sheet": a tenant's product data may come from a Google tab,
  // an uploaded CSV or an operator typing it (onboarding phase 3).
  PRODUCT_NOT_FOUND: "Product code not found in the catalog snapshot",
  MEDIA_NOT_FOUND: "No media assets found for product",
  OUT_OF_STOCK: "Product is out of stock or stock value invalid",
  SYNC_FAILED: "Catalog sync run failed",
  SYNC_SOURCE_EMPTY: "Sync stopped: the source returned nothing while the catalog is not empty",
  GOOGLE_NOT_CONNECTED: "Tenant has no connected Google account",
  GOOGLE_AUTH_EXPIRED: "Google refresh token was revoked or expired",
  GOOGLE_OAUTH_NOT_CONFIGURED: "Google OAuth app credentials are not configured",
  GOOGLE_CONNECT_STATE_INVALID: "Google OAuth callback failed its CSRF/state check",
  AI_PROVIDER_ERROR: "AI provider call failed",
  AI_RESPONSE_INVALID: "AI response failed structured-output validation",
  AI_RATE_LIMITED: "AI provider rate limit hit",
  AI_BUDGET_EXCEEDED: "Configured AI cost budget exceeded",
  CAPTION_VALIDATION_FAILED: "Generated caption failed validation rules",
  MODEL_NOT_CONFIGURED: "No model configured for task in registry",
  PROMPT_NOT_FOUND: "Prompt template not found for task",
  PROMPT_VERSION_NOT_FOUND: "Prompt version not found",
  BATCH_NOT_FOUND: "Post batch not found for tenant",
  CHANNEL_GROUP_NOT_FOUND: "Channel group not found for tenant",
  META_ERROR: "Graph API call failed",
  TOKEN_EXPIRED: "Channel access token expired or revoked",
  UPLOAD_HOST_NOT_ALLOWED: "Upload URL host is not in the allowlist",
  CHANNEL_NOT_CONFIGURED: "Channel not configured for tenant",
  DUPLICATE_POST_BLOCKED: "Duplicate publish blocked by idempotency lock",
  PUBLISH_FAILED: "Publish failed after allowed retries",
  INVALID_JOB_TRANSITION: "Post job state transition not allowed",
  DRAFT_PAYLOAD_REJECTED: "Draft payload failed compose-draft validation",
  DRAFT_TOO_LARGE: "Draft payload exceeds the stored draft size limit",
  VIDEO_SPEC_INVALID: "Video failed channel spec validation",
  VIDEO_PROBE_FAILED: "Could not probe video metadata",
  TIKTOK_ERROR: "TikTok API call failed",
};

export interface AppErrorOptions {
  /** English, for developers/logs. Defaults to the code's canonical message. */
  message?: string;
  /** Vietnamese, safe to show operators. Defaults to the code's canonical message. */
  userMessage?: string;
  context?: ErrorContext;
  cause?: unknown;
}

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === "string" && (ERROR_CODES as readonly string[]).includes(value);
}

export class AppError extends Error {
  /** Brand: survives duplicated module instances where `instanceof` breaks. */
  readonly _tag = "AppError" as const;
  readonly code: ErrorCode;
  readonly userMessage: string;
  readonly context: ErrorContext;

  constructor(code: ErrorCode, options: AppErrorOptions = {}) {
    // Guard: an unknown code must not silently produce an error without messages.
    const safeCode: ErrorCode = isErrorCode(code) ? code : "INTERNAL";
    super(options.message ?? DEFAULT_MESSAGES[safeCode], { cause: options.cause });

    this.name = "AppError";
    this.code = safeCode;
    this.userMessage = options.userMessage ?? DEFAULT_USER_MESSAGES[safeCode];
    this.context = options.context ?? {};
  }

  static is(value: unknown): value is AppError {
    if (value instanceof AppError) return true;
    return (
      typeof value === "object" &&
      value !== null &&
      (value as { _tag?: unknown })._tag === "AppError" &&
      isErrorCode((value as { code?: unknown }).code)
    );
  }

  /**
   * Wrap any thrown value into an AppError without losing the original cause.
   * Use at every boundary that catches unknown errors.
   */
  static from(value: unknown, fallback: ErrorCode = "INTERNAL", context?: ErrorContext): AppError {
    if (AppError.is(value)) {
      if (!context) return value;
      return new AppError(value.code, {
        message: value.message,
        userMessage: value.userMessage,
        context: { ...value.context, ...context },
        cause: value.cause ?? value,
      });
    }
    const message = value instanceof Error ? value.message : String(value);
    return new AppError(fallback, { message, context, cause: value });
  }

  /** Log-friendly shape. Never send this to a client as-is (leaks context). */
  toLogObject(): {
    code: ErrorCode;
    message: string;
    userMessage: string;
    context: ErrorContext;
    stack?: string;
    cause?: string;
  } {
    return {
      code: this.code,
      message: this.message,
      userMessage: this.userMessage,
      context: this.context,
      stack: this.stack,
      cause: this.cause === undefined ? undefined : String(this.cause),
    };
  }
}
