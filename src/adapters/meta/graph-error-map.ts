import { AppError } from "@/core/domain/errors";

/**
 * E5.5 — Graph API error -> AppError, with a Vietnamese message an operator can
 * act on and the original code kept in `context` for the log.
 *
 * Sources: Meta "Graph API — Error Codes" and "Handling errors" reference
 * (developers.facebook.com/docs/graph-api/guides/error-handling). The table is
 * pure data so it can be reviewed and tested without a network call.
 *
 * `retryable` is the contract with core/usecases/publish-post: false means the
 * error will not fix itself inside a backoff window, so the job goes straight to
 * `failed` (or `blocked` for TOKEN_EXPIRED) instead of burning attempts.
 */

export interface GraphErrorBody {
  readonly code?: number;
  readonly error_subcode?: number;
  readonly type?: string;
  readonly message?: string;
  readonly fbtrace_id?: string;
  readonly error_user_title?: string;
  readonly error_user_msg?: string;
}

export interface MapGraphErrorInput {
  /** Parsed `error` object of the Graph response, when there is one. */
  readonly error?: GraphErrorBody | null;
  /** HTTP status; used when the body carries no usable error code. */
  readonly httpStatus?: number | null;
  /** Transport failure (DNS, TLS, timeout) — no HTTP answer at all. */
  readonly cause?: unknown;
  /** Log-only context: tenant, job, channel, page id. NEVER a token. */
  readonly context?: Record<string, unknown>;
}

interface MappedGraphError {
  readonly code: "TOKEN_EXPIRED" | "META_ERROR";
  readonly userMessage: string;
  readonly retryable: boolean;
  /** Short machine reason for logs/tests. */
  readonly reason: string;
}

/** Graph error codes that mean "this credential is dead". */
const TOKEN_CODES = new Set([102, 190, 463, 467]);

/** Rate limiting / throttling — always worth another attempt with backoff. */
const RATE_LIMIT_CODES = new Set([4, 17, 32, 341, 613]);

/** Permission problems: a retry cannot grant a permission. */
const PERMISSION_CODES = new Set([3, 10, 200, 210, 283, 299]);

/** Meta's own "temporary problem, try again" family. */
const TRANSIENT_CODES = new Set([1, 2, 31]);

const BY_CODE: Readonly<Record<number, MappedGraphError>> = {
  100: {
    code: "META_ERROR",
    userMessage:
      "Facebook từ chối dữ liệu bài đăng (tham số hoặc ảnh không hợp lệ). Kiểm tra lại link ảnh và nội dung.",
    retryable: false,
    reason: "INVALID_PARAMETER",
  },
  368: {
    code: "META_ERROR",
    userMessage:
      "Trang đang bị Facebook tạm khoá đăng do vi phạm chính sách — không thể đăng lúc này.",
    retryable: false,
    reason: "TEMPORARILY_BLOCKED",
  },
  506: {
    code: "META_ERROR",
    userMessage: "Facebook báo bài đăng bị trùng nội dung — bài không được tạo.",
    retryable: false,
    reason: "DUPLICATE_POST",
  },
  1609005: {
    code: "META_ERROR",
    userMessage: "Facebook không tải được ảnh từ đường dẫn đã gửi. Kiểm tra link ảnh công khai.",
    retryable: false,
    reason: "MEDIA_FETCH_FAILED",
  },
};

export function mapGraphError(input: MapGraphErrorInput): AppError {
  // --- Edge cases first ----------------------------------------------------
  const error = input?.error ?? null;
  const httpStatus = typeof input?.httpStatus === "number" ? input.httpStatus : null;
  const graphCode = typeof error?.code === "number" ? error.code : null;
  const subcode = typeof error?.error_subcode === "number" ? error.error_subcode : null;

  const mapped = classify(graphCode, subcode, httpStatus, input?.cause);

  const message = [
    "Graph API error",
    graphCode === null ? null : `code=${graphCode}`,
    subcode === null ? null : `subcode=${subcode}`,
    httpStatus === null ? null : `http=${httpStatus}`,
    error?.message ? `message=${error.message}` : null,
  ]
    .filter(Boolean)
    .join(" ");

  return new AppError(mapped.code, {
    message,
    userMessage: mapped.userMessage,
    context: {
      ...(input?.context ?? {}),
      graph_code: graphCode,
      graph_subcode: subcode,
      graph_type: error?.type ?? null,
      graph_message: error?.message ?? null,
      graph_user_message: error?.error_user_msg ?? null,
      fbtrace_id: error?.fbtrace_id ?? null,
      http_status: httpStatus,
      retryable: mapped.retryable,
      reason: mapped.reason,
    },
    cause: input?.cause,
  });
}

function classify(
  graphCode: number | null,
  subcode: number | null,
  httpStatus: number | null,
  cause: unknown,
): MappedGraphError {
  if (graphCode !== null) {
    if (TOKEN_CODES.has(graphCode)) {
      return {
        code: "TOKEN_EXPIRED",
        userMessage:
          "Token của Page đã hết hạn hoặc bị thu hồi — cần kết nối lại kênh Facebook trước khi đăng.",
        retryable: false,
        reason: subcode === 458 ? "APP_REMOVED" : "TOKEN_INVALID",
      };
    }
    if (RATE_LIMIT_CODES.has(graphCode)) {
      return {
        code: "META_ERROR",
        userMessage: "Facebook đang giới hạn tần suất đăng — hệ thống sẽ tự thử lại sau ít phút.",
        retryable: true,
        reason: "RATE_LIMITED",
      };
    }
    if (PERMISSION_CODES.has(graphCode)) {
      return {
        code: "META_ERROR",
        userMessage:
          "Tài khoản kết nối không đủ quyền đăng bài lên Page này — cần cấp lại quyền quản trị/đăng bài.",
        retryable: false,
        reason: "PERMISSION_DENIED",
      };
    }
    if (TRANSIENT_CODES.has(graphCode)) {
      return {
        code: "META_ERROR",
        userMessage: "Facebook đang gặp sự cố tạm thời — hệ thống sẽ thử lại.",
        retryable: true,
        reason: "TEMPORARY_PLATFORM_ERROR",
      };
    }
    const known = BY_CODE[graphCode];
    if (known) return known;
  }

  if (httpStatus === 429) {
    return {
      code: "META_ERROR",
      userMessage: "Facebook đang giới hạn tần suất đăng — hệ thống sẽ tự thử lại sau ít phút.",
      retryable: true,
      reason: "HTTP_RATE_LIMITED",
    };
  }
  if (httpStatus !== null && httpStatus >= 500) {
    return {
      code: "META_ERROR",
      userMessage: "Máy chủ Facebook đang lỗi — hệ thống sẽ thử lại.",
      retryable: true,
      reason: "HTTP_SERVER_ERROR",
    };
  }
  if (httpStatus === 401 || httpStatus === 403) {
    return {
      code: "TOKEN_EXPIRED",
      userMessage:
        "Facebook từ chối truy cập (token hoặc quyền không hợp lệ) — cần kết nối lại kênh.",
      retryable: false,
      reason: "HTTP_UNAUTHORIZED",
    };
  }
  if (httpStatus !== null && httpStatus >= 400) {
    return {
      code: "META_ERROR",
      userMessage: "Facebook từ chối yêu cầu đăng bài. Xem nhật ký đăng để biết chi tiết.",
      retryable: false,
      reason: "HTTP_CLIENT_ERROR",
    };
  }
  if (cause !== undefined && cause !== null) {
    // No HTTP answer: timeout, DNS, TLS, socket. Always worth a retry.
    return {
      code: "META_ERROR",
      userMessage: "Không kết nối được tới Facebook — hệ thống sẽ thử lại.",
      retryable: true,
      reason: "NETWORK_ERROR",
    };
  }

  return {
    code: "META_ERROR",
    userMessage: "Facebook trả về lỗi không xác định khi đăng bài. Xem nhật ký đăng để biết chi tiết.",
    retryable: false,
    reason: "UNKNOWN",
  };
}

/** Whether the usecase should spend another attempt on this AppError. */
export function isRetryableAppError(error: AppError): boolean {
  return (error.context as { retryable?: unknown }).retryable !== false;
}
