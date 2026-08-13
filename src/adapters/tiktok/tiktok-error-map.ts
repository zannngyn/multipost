import { AppError, type ErrorCode } from "@/core/domain/errors";

/**
 * TikTok Content Posting API error -> AppError, in ONE table.
 *
 * The same three questions as graph-error-map: which AppError code, is a retry
 * worth anything, and what does the operator read. TikTok's failures are mostly
 * ACCOUNT-level (an unaudited app, an unverified domain, a privacy level the
 * creator does not allow) — a retry cannot fix any of those, so the Vietnamese
 * message has to say what a human must do instead.
 *
 * Codes: transient platform failures are TIKTOK_ERROR (502, retryable — the
 * queue backs off and tries again); permanent ones are PUBLISH_FAILED, and dead
 * credentials are TOKEN_EXPIRED so the job is blocked instead of retried. Every
 * AppError raised here carries `context.provider = "tiktok"` and `retryable`,
 * which is what publish-post and the logs key off.
 */

export interface TikTokErrorBody {
  /** "ok" on success; an error slug otherwise. */
  readonly code?: string;
  readonly message?: string;
  readonly log_id?: string;
}

export interface MapTikTokErrorInput {
  readonly error?: TikTokErrorBody | null;
  readonly httpStatus?: number;
  /** Transport failure (no answer at all). */
  readonly cause?: unknown;
  readonly context?: Record<string, unknown>;
}

interface Rule {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  /**
   * Null = the code's own Vietnamese default is already right. Only rules that
   * tell the operator something EXTRA (which limit, what to fix) override it.
   */
  readonly userMessage: string | null;
  readonly reason: string;
}

/** Documented slugs. Anything unknown falls back to a retryable platform error. */
const RULES: Readonly<Record<string, Rule>> = {
  // --- credentials --------------------------------------------------------
  access_token_invalid: {
    code: "TOKEN_EXPIRED",
    retryable: false,
    reason: "TOKEN_INVALID",
    userMessage:
      "Token TikTok không còn hiệu lực — cần kết nối lại tài khoản TikTok trước khi đăng.",
  },
  scope_not_authorized: {
    code: "TOKEN_EXPIRED",
    retryable: false,
    reason: "SCOPE_MISSING",
    userMessage:
      "Tài khoản TikTok chưa cấp quyền đăng video (video.publish) — kết nối lại và đồng ý quyền này.",
  },
  scope_permission_missed: {
    code: "TOKEN_EXPIRED",
    retryable: false,
    reason: "SCOPE_MISSING",
    userMessage:
      "Tài khoản TikTok chưa cấp quyền đăng video (video.publish) — kết nối lại và đồng ý quyền này.",
  },

  // --- transient ----------------------------------------------------------
  rate_limit_exceeded: {
    code: "TIKTOK_ERROR",
    retryable: true,
    reason: "RATE_LIMIT",
    userMessage: "TikTok đang giới hạn tần suất đăng (6 lần/phút) — hệ thống sẽ thử lại.",
  },
  spam_risk_too_many_posts: {
    code: "TIKTOK_ERROR",
    retryable: true,
    reason: "SPAM_RISK_TOO_MANY_POSTS",
    userMessage:
      "TikTok tạm chặn vì đăng quá nhiều trong thời gian ngắn — hệ thống sẽ thử lại sau.",
  },
  spam_risk_user_banned_from_posting: {
    code: "PUBLISH_FAILED",
    retryable: false,
    reason: "USER_BANNED_FROM_POSTING",
    userMessage: "Tài khoản TikTok đang bị hạn chế đăng bài — cần kiểm tra trực tiếp trên TikTok.",
  },
  internal_error: {
    code: "TIKTOK_ERROR",
    retryable: true,
    reason: "PLATFORM_INTERNAL_ERROR",
    // No userMessage: the code's own Vietnamese default already says it.
    userMessage: null,
  },

  // --- account / app configuration (a retry changes nothing) --------------
  unaudited_client_can_only_post_to_private_accounts: {
    code: "PUBLISH_FAILED",
    retryable: false,
    reason: "APP_NOT_AUDITED",
    userMessage:
      "Ứng dụng TikTok chưa qua kiểm duyệt nên chỉ đăng được vào tài khoản riêng tư (SELF_ONLY). Cần hoàn tất audit với TikTok hoặc đặt quyền riêng tư là 'Chỉ mình tôi'.",
  },
  url_ownership_unverified: {
    code: "PUBLISH_FAILED",
    retryable: false,
    reason: "URL_OWNERSHIP_UNVERIFIED",
    userMessage:
      "TikTok chưa xác minh tên miền chứa video — cần verify domain trong TikTok Developer Portal trước khi đăng.",
  },
  privacy_level_option_mismatch: {
    code: "PUBLISH_FAILED",
    retryable: false,
    reason: "PRIVACY_LEVEL_MISMATCH",
    userMessage:
      "Mức riêng tư đang chọn không nằm trong các mức TikTok cho phép với tài khoản này — chọn lại mức riêng tư.",
  },
  invalid_param: {
    code: "PUBLISH_FAILED",
    retryable: false,
    reason: "INVALID_PARAM",
    userMessage: "TikTok từ chối tham số bài đăng — xem nhật ký để biết trường nào sai.",
  },
  file_format_check_failed: {
    code: "PUBLISH_FAILED",
    retryable: false,
    reason: "FILE_FORMAT_REJECTED",
    userMessage: "TikTok không đọc được file video này — kiểm tra định dạng/độ dài rồi xuất lại.",
  },
  video_pull_failed: {
    code: "PUBLISH_FAILED",
    retryable: false,
    reason: "VIDEO_PULL_FAILED",
    userMessage:
      "TikTok không tải được video từ liên kết — kiểm tra liên kết công khai và tên miền đã verify.",
  },
};

/** Non-slug fallbacks by HTTP status. */
function ruleForStatus(httpStatus: number | undefined): Rule {
  if (httpStatus === 401 || httpStatus === 403) {
    return {
      code: "TOKEN_EXPIRED",
      retryable: false,
      reason: "UNAUTHORIZED",
      userMessage: "TikTok từ chối token — cần kết nối lại tài khoản TikTok.",
    };
  }
  if (httpStatus === 429) return RULES.rate_limit_exceeded;
  return {
    code: "TIKTOK_ERROR",
    retryable: true,
    reason: httpStatus && httpStatus >= 500 ? "PLATFORM_5XX" : "UNKNOWN_TIKTOK_ERROR",
    userMessage: null,
  };
}

export function mapTikTokError(input: MapTikTokErrorInput): AppError {
  const slug = typeof input?.error?.code === "string" ? input.error.code.trim() : "";
  // A transport failure never reached TikTok: always worth another attempt.
  if (!slug && input?.cause !== undefined && input?.httpStatus === undefined) {
    return new AppError("TIKTOK_ERROR", {
      message: `TikTok request failed before an answer: ${describe(input.cause)}`,
      userMessage: "Không kết nối được tới TikTok — hệ thống sẽ thử lại.",
      context: { ...(input.context ?? {}), provider: "tiktok", retryable: true, reason: "TRANSPORT" },
      cause: input.cause,
    });
  }

  const rule = RULES[slug] ?? ruleForStatus(input?.httpStatus);
  return new AppError(rule.code, {
    message: `TikTok error code=${slug || "(none)"} http=${input?.httpStatus ?? "n/a"} message=${
      input?.error?.message ?? ""
    }`,
    ...(rule.userMessage ? { userMessage: rule.userMessage } : {}),
    context: {
      ...(input?.context ?? {}),
      provider: "tiktok",
      tiktok_code: slug || null,
      tiktok_message: input?.error?.message ?? null,
      // TikTok's own request id: the only thing their support asks for.
      log_id: input?.error?.log_id ?? null,
      http_status: input?.httpStatus ?? null,
      retryable: rule.retryable,
      reason: rule.reason,
    },
    cause: input?.cause,
  });
}

/** `error.code === "ok"` is TikTok's way of saying "no error". */
export function isTikTokOk(error: TikTokErrorBody | null | undefined): boolean {
  const code = typeof error?.code === "string" ? error.code.trim().toLowerCase() : "";
  return code === "" || code === "ok";
}

function describe(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return String(cause);
}
