import { ApiError } from "@/ui/services/api-error";

/**
 * One place turning an `ApiError` into operator-facing copy.
 *
 * Two rules from core-feedback-states drive everything here:
 *  - errors are split by "can the operator fix it?", not by HTTP number;
 *  - a retry button only appears when retrying can actually succeed. Offering
 *    "Thử lại" on a 400 or a 404 is lying to the operator.
 */

export type ApiErrorKind =
  /** The operator typed something wrong — fix the input, do not retry. */
  | "input"
  /** The system is missing a credential/config — only an admin can fix it. */
  | "config"
  /** Business rule said no (hết hàng, thiếu ảnh) — not a failure of the app. */
  | "business"
  /** Session gone. */
  | "auth"
  /**
   * Signed in, but no company chosen (409 TENANT_NOT_SELECTED). Navigation,
   * not an error: the next step is picking a company, so the UI shows the
   * picker instead of a red box (doc 10 §3).
   */
  | "select-tenant"
  /** Server/transport problem — retrying is reasonable. */
  | "server";

/**
 * WHICH action the operator just took. The same error code means opposite
 * things depending on it: META_ERROR raised while PUBLISHING is "Facebook từ
 * chối bài đăng, chạy lại bài đó"; the same code raised while CANCELLING a post
 * Facebook already holds means the removal did NOT happen and the post will
 * publish itself at its hour. Telling the operator to "chạy lại" there is the
 * exact opposite of what has to be done.
 *
 * Left out (`undefined`) keeps the publishing/reading wording every other screen
 * uses today.
 */
export type ApiErrorOperation =
  | "cancel"
  /**
   * The platform admin screen (M3.2). The same codes mean something else
   * there: `FORBIDDEN` is about the PLATFORM role, not a membership role, and
   * `TENANT_NOT_FOUND` is "công ty này không tồn tại", not "bạn đã bị gỡ khỏi
   * công ty đó" — telling a super_admin they lost their membership would send
   * them looking for the wrong problem.
   */
  | "platform";

export interface PresentApiErrorOptions {
  readonly operation?: ApiErrorOperation;
}

export interface ApiErrorView {
  kind: ApiErrorKind;
  title: string;
  description: string;
  canRetry: boolean;
  /** Extra guidance shown under the message (admin steps, next action). */
  hint?: string;
  /** One line per reason, listed instead of glued into one sentence. */
  details?: string[];
}

/**
 * A rejected clip usually breaks SEVERAL rules at once (tỷ lệ + thời lượng +
 * fps), and the operator re-exporting it wants the whole list, not the first
 * item. The server joins them with "; " (core `summarizeViolations`), so the
 * list is split back here.
 *
 * PENDING(video-violations): a structured `violations[]` field on the error body
 * would be sturdier than splitting a sentence. Asked for; until it exists this
 * degrades safely — no separator simply means one line.
 */
function splitVideoViolations(userMessage: string): string[] {
  const afterColon = userMessage.split(/:\s/).slice(1).join(": ");
  const source = afterColon.trim().length > 0 ? afterColon : userMessage;
  return source
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/**
 * A config problem reaches the UI as INVALID_INPUT (composition/config.ts parses
 * `process.env` through zod), with the offending ENV VAR as the issue path.
 * That is how "chưa cấu hình Service Account / API key" is told apart from
 * "người dùng gõ sai mã sản phẩm" — both are 400.
 */
const ENV_VAR_PATTERN = /^[A-Z][A-Z0-9_]*$/;

export function isSystemConfigError(error: ApiError): boolean {
  if (error.code !== "INVALID_INPUT") return false;
  return (error.issues ?? []).some((issue) => ENV_VAR_PATTERN.test(issue.path));
}

/** Names the missing variables so an admin knows exactly what to set. */
export function missingConfigKeys(error: ApiError): string[] {
  return (error.issues ?? [])
    .map((issue) => issue.path)
    .filter((path) => ENV_VAR_PATTERN.test(path));
}

export function toApiError(error: unknown): ApiError {
  if (ApiError.is(error)) return error;
  return new ApiError({
    code: "INTERNAL",
    status: 0,
    message: error instanceof Error ? error.message : String(error),
    userMessage: "Hệ thống gặp sự cố không xác định. Vui lòng thử lại sau ít phút.",
    cause: error,
  });
}

/**
 * Config keys of the media bridge (E3.6). Missing them has one very concrete
 * consequence an operator can be told about: Facebook has no public address to
 * fetch the photo from, so nothing can be posted.
 */
const MEDIA_CONFIG_KEYS = ["MEDIA_PUBLIC_BASE_URL", "MEDIA_SIGNING_SECRET"];

/**
 * Copy for errors raised by the CANCEL action (E8.4/E8.6).
 *
 * Only the codes whose shared copy would point the operator the wrong way are
 * listed; everything else falls through to the branch below, which stays the
 * single owner of config/validation/session wording.
 *
 * The reason sentence is NOT written here: it stays `error.userMessage`, built
 * by the usecase, which is the only layer that knows whether Facebook confirmed
 * the removal. This function owns the title and the next step around it.
 */
function presentCancelError(error: ApiError): ApiErrorView | null {
  switch (error.code) {
    // The dangerous branch: the post is still scheduled on the Page and nothing
    // in the system retries a cancel. TOKEN_EXPIRED belongs here too — during a
    // cancel it is the PAGE token, not the operator's session, so the sign-in
    // link of the shared branch would send them nowhere useful.
    case "META_ERROR":
    case "PUBLISH_FAILED":
    case "TOKEN_EXPIRED":
      return {
        kind: "business",
        title: "Chưa gỡ được bài khỏi Facebook",
        description: error.userMessage,
        hint: "Hệ thống không tự huỷ lại lần nữa. Sau khi xoá tay trên Trang, hãy tải lại danh sách bài đã hẹn để đối chiếu; bài ở đây vẫn giữ nguyên trạng thái cũ.",
        canRetry: false,
      };

    // Refused, or the hour arrived mid-click. Nothing about "chạy lại" applies.
    case "INVALID_JOB_TRANSITION":
      return {
        kind: "business",
        title: "Không huỷ được bài này",
        description: error.userMessage,
        hint: "Tải lại danh sách bài đã hẹn để xem trạng thái mới nhất trước khi làm tiếp.",
        canRetry: false,
      };

    default:
      return null;
  }
}

/**
 * Copy for errors raised on the PLATFORM admin screen (M3.2).
 *
 * Only the codes whose shared copy would point the operator the wrong way are
 * listed; everything else falls through to the branch below, which stays the
 * single owner of config/validation/session wording.
 */
function presentPlatformError(error: ApiError): ApiErrorView | null {
  switch (error.code) {
    // Not about a membership: this account's PLATFORM role is not enough. There
    // is nothing to ask a company owner for, so the copy does not suggest it.
    case "FORBIDDEN":
      return {
        kind: "business",
        title: "Bạn không có quyền quản trị nền tảng",
        description: `${error.userMessage} Tạo và khoá công ty chỉ dành cho quản trị nền tảng (super_admin); tài khoản hỗ trợ chỉ xem được danh sách.`,
        canRetry: false,
      };

    // Addressed by id from outside every tenant, so "bạn đã bị gỡ khỏi công ty"
    // would be nonsense here.
    case "TENANT_NOT_FOUND":
      return {
        kind: "business",
        title: "Không tìm thấy công ty này",
        description: `${error.userMessage} Công ty có thể vừa bị xoá hoặc mã công ty không còn đúng.`,
        hint: "Tải lại danh sách công ty để xem trạng thái mới nhất.",
        canRetry: false,
      };

    default:
      return null;
  }
}

export function presentApiError(
  error: ApiError,
  options?: PresentApiErrorOptions,
): ApiErrorView {
  if (isSystemConfigError(error)) {
    const keys = missingConfigKeys(error);
    const isMediaConfig = keys.some((key) => MEDIA_CONFIG_KEYS.includes(key));
    return {
      kind: "config",
      title: isMediaConfig
        ? "Hệ thống chưa cấu hình URL công khai cho ảnh"
        : "Hệ thống chưa được cấu hình đủ",
      description: isMediaConfig
        ? "Facebook phải tự tải ảnh về từ một địa chỉ công khai của hệ thống, mà địa chỉ đó chưa được khai báo. Chưa đăng được bài nào cho tới khi quản trị viên khai báo xong — không phải lỗi thao tác."
        : "Tính năng này cần thông tin kết nối mà máy chủ chưa có. Người vận hành không tự khắc phục được — hãy gửi phần dưới đây cho quản trị viên.",
      hint:
        keys.length > 0
          ? `Thiếu biến cấu hình: ${keys.join(", ")}. Khai báo trong .env.local của máy chủ rồi khởi động lại.`
          : undefined,
      canRetry: false,
    };
  }

  // A missing env var is a missing env var whatever the operator clicked, so the
  // config guard stays first; from here on the action decides the wording.
  if (options?.operation === "cancel") {
    const cancelView = presentCancelError(error);
    if (cancelView) return cancelView;
  }

  if (options?.operation === "platform") {
    const platformView = presentPlatformError(error);
    if (platformView) return platformView;
  }

  switch (error.code) {
    case "INVALID_INPUT":
      return {
        kind: "input",
        title: "Dữ liệu nhập chưa hợp lệ",
        description: error.userMessage,
        hint: (error.issues ?? []).map((issue) => issue.message).join(" · ") || undefined,
        canRetry: false,
      };

    case "UNAUTHORIZED":
    case "TOKEN_EXPIRED":
      return {
        kind: "auth",
        title: "Phiên đăng nhập đã kết thúc",
        description: `${error.userMessage} Đăng nhập lại để tiếp tục — nội dung bạn đã nhập vẫn còn trên màn hình.`,
        canRetry: false,
      };

    /**
     * 409 (doc 10 §3): there IS a session, no company is selected yet. Not a
     * failure and not the operator's mistake — it is a fork in the road, so it
     * gets its own kind and the picker, never a red box.
     */
    case "TENANT_NOT_SELECTED":
      return {
        kind: "select-tenant",
        title: "Chưa chọn công ty để làm việc",
        description: `${error.userMessage} Chọn công ty ở phía trên rồi thao tác lại — dữ liệu của mỗi công ty được tách riêng.`,
        canRetry: false,
      };

    /**
     * 404, deliberately indistinguishable from "không tồn tại" (doc 10 §3):
     * the account has no membership in that company. Never says "sai mã" any
     * more — the operator no longer types a tenant id anywhere.
     */
    case "TENANT_NOT_FOUND":
      return {
        kind: "business",
        title: "Không mở được công ty này",
        description: `${error.userMessage} Có thể bạn đã bị gỡ khỏi công ty đó, hoặc nó đã bị khoá. Chọn một công ty khác, hoặc nhờ quản trị viên mời lại.`,
        canRetry: false,
      };

    /**
     * 409 (M2.1): the account hit the create ceiling — three companies, or one
     * in the last hour. The server's own sentence says WHICH, because only it
     * knows; this side must not guess and must not offer a retry that would
     * fail identically.
     */
    case "TENANT_LIMIT_REACHED":
      return {
        kind: "business",
        title: "Chưa tạo thêm công ty được lúc này",
        description: error.userMessage,
        hint: "Nếu bạn cần thêm công ty, hãy liên hệ quản trị hệ thống. Bạn vẫn làm việc bình thường ở những công ty đang có.",
        canRetry: false,
      };

    /**
     * 409 (M2.1): the slug belongs to someone else. Field-level by nature — the
     * form places it under the slug box (see `isCreateTenantField`), so the
     * copy here only has to say what to change.
     */
    case "SLUG_TAKEN":
      return {
        kind: "input",
        title: "Đường dẫn này đã có người dùng",
        description: `${error.userMessage} Chọn một đường dẫn khác — ví dụ thêm tên chi nhánh hoặc năm.`,
        canRetry: false,
      };

    /**
     * 404 (M2.2): ONE code for every reason an invite fails — hết hạn, đã thu
     * hồi, đã dùng, không tồn tại. Deliberately indistinguishable, so this copy
     * must not speculate about which one it was.
     */
    case "INVITE_INVALID":
      return {
        kind: "business",
        title: "Link mời không còn hiệu lực",
        description: `${error.userMessage} Link mời có thể đã hết hạn, đã được dùng hoặc đã bị thu hồi.`,
        hint: "Xin quản trị viên của công ty gửi lại một link mời mới.",
        canRetry: false,
      };

    /**
     * 404 (M2.3, verified against the running API): the membership is not in
     * this company any more — almost always because somebody else removed it
     * first. Retrying the same call cannot succeed; re-reading the list can.
     */
    case "MEMBER_NOT_FOUND":
      return {
        kind: "business",
        title: "Không còn thành viên này trong công ty",
        description: `${error.userMessage} Có thể người khác vừa gỡ họ trước bạn.`,
        hint: "Tải lại danh sách thành viên để xem ai còn trong công ty.",
        canRetry: false,
      };

    /**
     * 409 (M2.3): the change would leave the company with no owner. Refused by
     * the server as an invariant, not as a permission — so the wording points
     * at the fix (hand ownership over first) instead of at the operator's role.
     */
    case "LAST_OWNER":
      return {
        kind: "business",
        title: "Công ty phải còn ít nhất một chủ sở hữu",
        description: error.userMessage,
        hint: "Hãy cấp vai trò Chủ sở hữu cho một thành viên khác trước, rồi quay lại thao tác này.",
        canRetry: false,
      };

    /** 403: has a membership, lacks the role. Retrying changes nothing. */
    case "FORBIDDEN":
      return {
        kind: "business",
        title: "Bạn không có quyền thao tác này",
        description: `${error.userMessage} Vai trò hiện tại của bạn trong công ty này không đủ để làm việc đó — nhờ chủ sở hữu hoặc quản trị viên nâng quyền nếu bạn cần.`,
        canRetry: false,
      };

    case "PRODUCT_NOT_FOUND":
      return {
        kind: "business",
        title: "Không tìm thấy mã sản phẩm",
        description: `${error.userMessage} Kiểm tra lại mã, hoặc chạy đồng bộ dữ liệu nếu mã vừa được thêm vào Sheet.`,
        canRetry: false,
      };

    case "OUT_OF_STOCK":
      return {
        kind: "business",
        title: "Mã này bị chặn đăng",
        description: error.userMessage,
        hint: "Quy tắc bắt buộc: hết hàng thì không đăng. Chọn mã khác hoặc cập nhật cột Tồn trên Sheet rồi đồng bộ lại.",
        canRetry: false,
      };

    case "MEDIA_NOT_FOUND":
      return {
        kind: "business",
        title: "Chưa có ảnh dùng được",
        description: error.userMessage,
        hint: "Kiểm tra thư mục Drive và tên file, sau đó chạy lại đồng bộ dữ liệu.",
        canRetry: false,
      };

    case "VIDEO_SPEC_INVALID": {
      const details = splitVideoViolations(error.userMessage);
      const listed = details.length > 0 && details[0] !== error.userMessage;
      // Everything before the colon names the file; the rules go to `details`.
      const headline = listed ? error.userMessage.split(/:\s/)[0] : error.userMessage;
      return {
        kind: "business",
        title: "Video chưa đạt thông số để đăng",
        description: headline.endsWith(".") ? headline : `${headline}.`,
        details: listed ? details : undefined,
        hint: "Xuất lại clip theo đúng yêu cầu bên trên, hoặc đổi đích đăng (Reels chặt hơn Video thường), rồi tra lại mã.",
        canRetry: false,
      };
    }

    case "VIDEO_PROBE_FAILED":
      return {
        kind: "business",
        title: "Không kiểm tra được thông số video",
        description: error.userMessage,
        hint: "File có thể hỏng, không phải video, hoặc chưa tải được từ Drive. Kiểm tra file trên Drive rồi chạy lại đồng bộ; hệ thống không đăng clip chưa kiểm được.",
        canRetry: false,
      };

    case "SYNC_FAILED":
      return {
        kind: "config",
        title: "Không chạy được đồng bộ",
        description: error.userMessage,
        canRetry: false,
      };

    case "CAPTION_VALIDATION_FAILED":
      return {
        kind: "business",
        title: "Caption không qua được kiểm tra",
        description: error.userMessage,
        hint: "Bấm “Viết lại” để tạo bản khác, hoặc tự nhập caption rồi duyệt tay.",
        canRetry: true,
      };

    case "AI_RATE_LIMITED":
    case "AI_BUDGET_EXCEEDED":
      return {
        kind: "server",
        title: "Dịch vụ AI đang bị giới hạn",
        description: error.userMessage,
        hint: "Có thể nhập caption tay để không phải chờ.",
        canRetry: true,
      };

    case "AI_PROVIDER_ERROR":
    case "AI_RESPONSE_INVALID":
      return {
        kind: "server",
        title: "Không tạo được caption",
        description: error.userMessage,
        hint: "Có thể nhập caption tay để không phải chờ.",
        canRetry: true,
      };

    case "DRIVE_ERROR":
    case "SHEET_ERROR":
      return {
        kind: "server",
        title: "Không đọc được Google Drive / Sheet",
        description: error.userMessage,
        canRetry: true,
      };

    case "INVALID_JOB_TRANSITION":
      return {
        kind: "business",
        title: "Không chạy lại được bài này",
        description: error.userMessage,
        hint: "Chỉ bài đang ở trạng thái Lỗi hoặc Bị chặn mới chạy lại được. Tải lại nhật ký để xem trạng thái mới nhất.",
        canRetry: false,
      };

    case "DUPLICATE_POST_BLOCKED":
      return {
        kind: "business",
        title: "Bài này đã được tạo trước đó",
        description: error.userMessage,
        // No hint on purpose. Two situations raise this code and they need
        // opposite instructions — a second batch points at the job log, a
        // refused retry points at the Page's scheduled posts — so the server's
        // userMessage is the only text that knows which one happened.
        canRetry: false,
      };

    case "CHANNEL_NOT_CONFIGURED":
      return {
        kind: "config",
        title: "Kênh chưa được cấu hình",
        description: error.userMessage,
        hint: "Kênh cần Page ID và token hợp lệ trong cấu hình đơn vị. Nhờ quản trị viên kết nối kênh rồi thử lại.",
        canRetry: false,
      };

    case "QUEUE_ERROR":
      return {
        kind: "server",
        title: "Không đưa được bài vào hàng đợi",
        description: `${error.userMessage} Bài vẫn giữ nguyên trạng thái cũ — chưa có gì được đăng.`,
        canRetry: true,
      };

    // PUBLISHING path only — a cancel that fails is handled above, because
    // "Chạy lại" is the last thing to do with a post that is still scheduled.
    case "META_ERROR":
    case "PUBLISH_FAILED":
      return {
        kind: "server",
        title: "Facebook từ chối bài đăng",
        description: error.userMessage,
        hint: "Xem nhật ký đăng bài để biết kênh nào lỗi, rồi bấm “Chạy lại” trên đúng dòng đó.",
        canRetry: true,
      };

    case "DB_ERROR":
      return {
        kind: "server",
        title: "Không truy cập được cơ sở dữ liệu",
        description: `${error.userMessage} Đây là sự cố phía máy chủ — thử lại sau ít phút, báo quản trị viên nếu kéo dài.`,
        canRetry: true,
      };

    default:
      return {
        kind: error.isRetryable ? "server" : "input",
        title: "Thao tác không thành công",
        description: error.userMessage,
        canRetry: error.isRetryable,
      };
  }
}
