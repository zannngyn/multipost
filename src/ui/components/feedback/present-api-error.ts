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
  /** Server/transport problem — retrying is reasonable. */
  | "server";

export interface ApiErrorView {
  kind: ApiErrorKind;
  title: string;
  description: string;
  canRetry: boolean;
  /** Extra guidance shown under the message (admin steps, next action). */
  hint?: string;
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

export function presentApiError(error: ApiError): ApiErrorView {
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

    case "TENANT_NOT_FOUND":
      return {
        kind: "input",
        title: "Không tìm thấy đơn vị",
        description: `${error.userMessage} Kiểm tra lại mã đơn vị, hoặc hỏi quản trị viên mã đúng.`,
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
        hint: "Khoá chống đăng trùng đã chặn lần tạo thứ hai. Mở nhật ký đăng bài để xem lô đã có.",
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
