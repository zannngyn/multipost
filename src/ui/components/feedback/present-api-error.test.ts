import { describe, expect, it } from "vitest";

import { ApiError } from "@/ui/services/api-error";

import { isSystemConfigError, missingConfigKeys, presentApiError, toApiError } from "./present-api-error";

/**
 * Edge cases first (CLAUDE.md technical rule 1). The rule that must never
 * regress: a retry button may only appear where retrying can succeed.
 */

function makeError(params: Partial<ConstructorParameters<typeof ApiError>[0]> = {}): ApiError {
  return new ApiError({
    code: "INTERNAL",
    status: 500,
    userMessage: "Lỗi.",
    ...params,
  });
}

describe("toApiError", () => {
  it("passes an ApiError through untouched", () => {
    const original = makeError({ code: "DB_ERROR", status: 503 });
    expect(toApiError(original)).toBe(original);
  });

  it("wraps a thrown Error without losing its message", () => {
    const wrapped = toApiError(new Error("boom"));
    expect(wrapped.code).toBe("INTERNAL");
    expect(wrapped.message).toBe("boom");
    expect(wrapped.userMessage).toMatch(/sự cố/i);
  });

  it("wraps a non-Error throwable", () => {
    expect(toApiError("nope").code).toBe("INTERNAL");
  });
});

describe("isSystemConfigError", () => {
  it("detects a missing env var reported as INVALID_INPUT", () => {
    const error = makeError({
      code: "INVALID_INPUT",
      status: 400,
      issues: [{ path: "OPENAI_API_KEY", message: "OPENAI_API_KEY is required" }],
    });
    expect(isSystemConfigError(error)).toBe(true);
    expect(missingConfigKeys(error)).toEqual(["OPENAI_API_KEY"]);
  });

  it("does NOT treat a normal field error as a config problem", () => {
    const error = makeError({
      code: "INVALID_INPUT",
      status: 400,
      issues: [{ path: "productCode", message: "Thiếu mã sản phẩm." }],
    });
    expect(isSystemConfigError(error)).toBe(false);
    expect(missingConfigKeys(error)).toEqual([]);
  });

  it("does not look at issues of other codes", () => {
    const error = makeError({
      code: "DB_ERROR",
      status: 503,
      issues: [{ path: "DATABASE_URL", message: "x" }],
    });
    expect(isSystemConfigError(error)).toBe(false);
  });

  it("survives a missing issues array", () => {
    expect(isSystemConfigError(makeError({ code: "INVALID_INPUT", status: 400 }))).toBe(false);
  });
});

describe("presentApiError", () => {
  it("offers no retry for a system config gap and names the variable", () => {
    const view = presentApiError(
      makeError({
        code: "INVALID_INPUT",
        status: 400,
        issues: [{ path: "GOOGLE_SERVICE_ACCOUNT_JSON", message: "required" }],
      }),
    );
    expect(view.kind).toBe("config");
    expect(view.canRetry).toBe(false);
    expect(view.hint).toContain("GOOGLE_SERVICE_ACCOUNT_JSON");
  });

  it("offers no retry for a validation error and repeats the field message", () => {
    const view = presentApiError(
      makeError({
        code: "INVALID_INPUT",
        status: 400,
        userMessage: "Dữ liệu gửi lên không hợp lệ.",
        issues: [{ path: "productCode", message: "Thiếu mã sản phẩm." }],
      }),
    );
    expect(view.kind).toBe("input");
    expect(view.canRetry).toBe(false);
    expect(view.hint).toContain("Thiếu mã sản phẩm.");
  });

  it.each([
    ["OUT_OF_STOCK", 409],
    ["MEDIA_NOT_FOUND", 404],
    ["PRODUCT_NOT_FOUND", 404],
  ])("treats %s as a business block with no retry", (code, status) => {
    const view = presentApiError(makeError({ code, status, userMessage: "Bị chặn." }));
    expect(view.kind).toBe("business");
    expect(view.canRetry).toBe(false);
  });

  it("allows retrying server-side failures", () => {
    expect(presentApiError(makeError({ code: "DB_ERROR", status: 503 })).canRetry).toBe(true);
    expect(presentApiError(makeError({ code: "DRIVE_ERROR", status: 503 })).canRetry).toBe(true);
    expect(presentApiError(makeError({ code: "AI_PROVIDER_ERROR", status: 502 })).canRetry).toBe(
      true,
    );
  });

  it("routes an expired session to the sign-in path, not to a retry", () => {
    const view = presentApiError(makeError({ code: "UNAUTHORIZED", status: 401 }));
    expect(view.kind).toBe("auth");
    expect(view.canRetry).toBe(false);
  });

  it("falls back to the transport verdict for unknown codes", () => {
    expect(presentApiError(makeError({ code: "SOMETHING_NEW", status: 500 })).canRetry).toBe(true);
    expect(presentApiError(makeError({ code: "SOMETHING_NEW", status: 418 })).canRetry).toBe(false);
    // status 0 = the request never got an answer; retrying is the right move.
    expect(presentApiError(makeError({ code: "NETWORK_ERROR", status: 0 })).canRetry).toBe(true);
  });
});

/**
 * E8.6 — a cancel that fails leaves the post SCHEDULED on Facebook: it will
 * publish itself. The copy around the server's reason must never send the
 * operator to "Chạy lại" (the publish flow's next step) or to the sign-in page.
 */
describe("presentApiError — cancelling a scheduled post", () => {
  const STILL_ON_FACEBOOK =
    "Bài này đã được giao cho Facebook giữ. Hệ thống chưa gỡ được nó, nên bài VẪN SẼ TỰ ĐĂNG — hãy vào Trang, mục bài đã lên lịch, để xoá thủ công.";

  it.each(["META_ERROR", "PUBLISH_FAILED", "TOKEN_EXPIRED"])(
    "never tells the operator to re-run the post when %s breaks the cancel",
    (code) => {
      const view = presentApiError(
        makeError({ code, status: 502, userMessage: STILL_ON_FACEBOOK }),
        { operation: "cancel" },
      );
      expect(view.title).not.toMatch(/từ chối/i);
      expect(`${view.title} ${view.hint ?? ""}`).not.toMatch(/chạy lại/i);
      expect(view.kind).not.toBe("auth");
      expect(view.canRetry).toBe(false);
      // The reason itself stays the server's sentence, word for word.
      expect(view.description).toBe(STILL_ON_FACEBOOK);
      expect(view.hint).toBeTruthy();
    },
  );

  it("keeps the publish wording when no operation is given", () => {
    const view = presentApiError(makeError({ code: "META_ERROR", status: 502 }));
    expect(view.title).toBe("Facebook từ chối bài đăng");
    expect(view.hint).toMatch(/chạy lại/i);
    expect(view.canRetry).toBe(true);
  });

  it("drops the retry-flow hint when a cancel is refused", () => {
    const refusal = "Bài này đang được đăng — không huỷ được nữa.";
    const view = presentApiError(
      makeError({ code: "INVALID_JOB_TRANSITION", status: 409, userMessage: refusal }),
      { operation: "cancel" },
    );
    expect(view.description).toBe(refusal);
    expect(view.hint).not.toMatch(/chạy lại/i);
    expect(view.canRetry).toBe(false);
  });

  it("leaves codes with no cancel-specific meaning on the shared branch", () => {
    const view = presentApiError(makeError({ code: "DB_ERROR", status: 503 }), {
      operation: "cancel",
    });
    expect(view.title).toBe("Không truy cập được cơ sở dữ liệu");
  });

  it("still reports a missing env var as a config gap during a cancel", () => {
    const view = presentApiError(
      makeError({
        code: "INVALID_INPUT",
        status: 400,
        issues: [{ path: "META_APP_SECRET", message: "required" }],
      }),
      { operation: "cancel" },
    );
    expect(view.kind).toBe("config");
    expect(view.hint).toContain("META_APP_SECRET");
  });
});

describe("presentApiError — video posts (E10.1 Phase 2)", () => {
  const SPEC_MESSAGE =
    'Video "MGKVX6310 TRẮNG 1.mp4" chưa đạt thông số để đăng: Video dài 2,0 giây — Reels Facebook yêu cầu tối thiểu 3,0 giây; Tỷ lệ khung hình 16:9 (1920x1080) không hợp lệ — Reels Facebook cần tỷ lệ 9:16';

  it("lists every violation instead of gluing them into one sentence", () => {
    const view = presentApiError(
      makeError({ code: "VIDEO_SPEC_INVALID", status: 422, userMessage: SPEC_MESSAGE }),
    );
    expect(view.kind).toBe("business");
    expect(view.canRetry).toBe(false);
    expect(view.details).toHaveLength(2);
    expect(view.details?.[0]).toContain("tối thiểu 3,0 giây");
    expect(view.details?.[1]).toContain("9:16");
    // The file name stays in the headline, not repeated in every bullet.
    expect(view.description).toContain("MGKVX6310");
  });

  it("keeps a single-reason message readable with no bullet list", () => {
    const view = presentApiError(
      makeError({
        code: "VIDEO_SPEC_INVALID",
        status: 422,
        userMessage: "Video chưa đạt thông số để đăng",
      }),
    );
    expect(view.details).toBeUndefined();
    expect(view.description).toBe("Video chưa đạt thông số để đăng.");
  });

  it("never offers a retry when the clip could not be probed", () => {
    const view = presentApiError(
      makeError({
        code: "VIDEO_PROBE_FAILED",
        status: 422,
        userMessage: "Không kiểm tra được thông số video.",
      }),
    );
    expect(view.kind).toBe("business");
    expect(view.canRetry).toBe(false);
    expect(view.hint).toBeTruthy();
  });

  /**
   * M1.4 / doc 10 §3 — the three answers a request can now get about WHICH
   * company it belongs to. The rule under test: only one of them is an error
   * the operator caused, and none of the three may offer a retry.
   */
  it("treats 409 TENANT_NOT_SELECTED as a fork in the road, not a failure", () => {
    const view = presentApiError(
      makeError({
        code: "TENANT_NOT_SELECTED",
        status: 409,
        userMessage: "Bạn chưa chọn công ty để làm việc.",
      }),
    );
    // A dedicated kind: the picker is what answers this, not a red box.
    expect(view.kind).toBe("select-tenant");
    expect(view.canRetry).toBe(false);
    expect(view.title).toContain("Chưa chọn công ty");
  });

  it("does not blame the operator for a company they cannot open (404)", () => {
    const view = presentApiError(
      makeError({
        code: "TENANT_NOT_FOUND",
        status: 404,
        userMessage: "Không tìm thấy công ty này.",
      }),
    );
    expect(view.canRetry).toBe(false);
    // Nobody types a company id any more, so "sai mã" would be nonsense advice.
    expect(view.description).not.toContain("mã đơn vị");
    expect(view.description).toContain("gỡ khỏi công ty");
  });

  it("says plainly that 403 is a missing role, and offers no retry", () => {
    const view = presentApiError(
      makeError({
        code: "FORBIDDEN",
        status: 403,
        userMessage: "Bạn không đủ quyền cho thao tác này.",
      }),
    );
    expect(view.kind).toBe("business");
    expect(view.canRetry).toBe(false);
    expect(view.title).toContain("không có quyền");
  });

  /**
   * M2.1/M2.2 — the three refusals on the way INTO a company. None of them may
   * offer a retry (the same request fails the same way), and only one of them
   * is about something the operator typed.
   */
  it("does not speculate about which create limit was hit", () => {
    const view = presentApiError(
      makeError({
        code: "TENANT_LIMIT_REACHED",
        status: 409,
        userMessage: "Bạn đã tạo 3 công ty — không tạo thêm được.",
      }),
    );
    expect(view.canRetry).toBe(false);
    // The count/window belongs to the server's sentence, not to a guess here.
    expect(view.description).toBe("Bạn đã tạo 3 công ty — không tạo thêm được.");
    expect(view.hint).toBeTruthy();
  });

  it("treats a taken slug as something to fix, not something to retry", () => {
    const view = presentApiError(
      makeError({
        code: "SLUG_TAKEN",
        status: 409,
        userMessage: "Đường dẫn “nha-xe-an-anh” đã có người dùng.",
      }),
    );
    expect(view.kind).toBe("input");
    expect(view.canRetry).toBe(false);
  });

  it("keeps an invalid invite neutral and never guesses the reason", () => {
    const view = presentApiError(
      makeError({
        code: "INVITE_INVALID",
        status: 404,
        userMessage: "Lời mời này không dùng được.",
      }),
    );
    expect(view.canRetry).toBe(false);
    expect(view.title).toContain("không còn hiệu lực");
    // One code covers hết hạn / thu hồi / đã dùng — the copy says so instead of
    // picking one and being wrong two times out of three.
    expect(view.description).toContain("hết hạn");
    expect(view.description).toContain("thu hồi");
    expect(view.hint).toContain("link mời mới");
  });

  it("points a LAST_OWNER refusal at the fix, not at the operator's role", () => {
    const view = presentApiError(
      makeError({
        code: "LAST_OWNER",
        status: 409,
        userMessage: "Công ty phải còn ít nhất một chủ sở hữu.",
      }),
    );
    expect(view.canRetry).toBe(false);
    // It is an invariant, not a permission — the next step is handing ownership
    // over, and saying "bạn không có quyền" here would send someone to ask an
    // admin for something no admin can grant.
    expect(view.hint).toContain("Chủ sở hữu");
    expect(view.title).toContain("ít nhất một chủ sở hữu");
  });
});
