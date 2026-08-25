import { z } from "zod";

import type { StatusTone } from "./post-batch.schema";

/**
 * Contracts of the "Đồng bộ dữ liệu" screen (E2 read model + trigger).
 *
 * `ui/` may not import `core/` (one-way dependency law, docs/07 §2), so these
 * schemas MIRROR `core/ports/product-repo.ts` (SyncIssue, SyncRunCounts,
 * SyncRunSummary) and `core/usecases/sync-catalog.ts` (SyncCatalogResult).
 * Any change there must be reflected here — the mirror is deliberate, and the
 * runtime parse in `http-client` is what makes a drift loud instead of silent.
 */

export const SYNC_RUN_STATUSES = ["running", "succeeded", "partial", "failed"] as const;
export const SyncRunStatusSchema = z.enum(SYNC_RUN_STATUSES);
export type SyncRunStatus = z.infer<typeof SyncRunStatusSchema>;

export const SyncIssueSchema = z.object({
  errorCode: z.string(),
  reason: z.string(),
  ref: z.string(),
  detail: z.string(),
});
export type SyncIssue = z.infer<typeof SyncIssueSchema>;

/**
 * Per-code tally computed BEFORE the server capped `issues[]`, so `count` is the
 * real number while `examples` is at most three rows. Mirrors `SyncIssueGroup`
 * in `core/ports/product-repo.ts`.
 */
export const SyncIssueGroupSchema = z.object({
  errorCode: z.string(),
  count: z.number(),
  examples: z.array(SyncIssueSchema),
});
export type SyncIssueGroup = z.infer<typeof SyncIssueGroupSchema>;

export const SyncRunCountsSchema = z.object({
  driveFilesSeen: z.number(),
  mediaParsed: z.number(),
  mediaRejected: z.number(),
  mediaDuplicatesDropped: z.number(),
  mediaNeedingReview: z.number(),
  sheetRowsSeen: z.number(),
  productsParsed: z.number(),
  sheetRowsRejected: z.number(),
  productsWithConflict: z.number(),
  productsWithoutMedia: z.number(),
  mediaWithoutProduct: z.number(),
  productsWritten: z.number(),
  mediaWritten: z.number(),
  productsDeleted: z.number(),
  mediaDeleted: z.number(),
  /** Issues DETECTED — always exact, even when `issues[]` is capped at 200. */
  issuesTotal: z.number(),
  issuesTruncated: z.boolean(),
});
export type SyncRunCounts = z.infer<typeof SyncRunCountsSchema>;

/**
 * One line of the "lần chạy gần đây" list. No issues, no groups: a five-row
 * history must not carry the payload of five full runs.
 */
export const RecentSyncRunSchema = z.object({
  syncRunId: z.string().min(1),
  status: SyncRunStatusSchema,
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
  /** Null when that run wrote no counts (still running, or crashed). */
  issuesTotal: z.number().nullable(),
  errorCode: z.string().nullable(),
});
export type RecentSyncRun = z.infer<typeof RecentSyncRunSchema>;

export const SyncRunSchema = z.object({
  tenantId: z.string().min(1),
  syncRunId: z.string().min(1),
  status: SyncRunStatusSchema,
  startedAt: z.iso.datetime(),
  /** Null while the run is still `running`, or when it crashed mid-way. */
  finishedAt: z.iso.datetime().nullable(),
  /** Null until the run finishes — a `running` row has no counts yet. */
  counts: SyncRunCountsSchema.nullable(),
  issues: z.array(SyncIssueSchema),
  /**
   * NULL for runs stored before the server grouped issues. The screen must then
   * fall back to counting the capped `issues[]` — never render 0 groups.
   */
  issueGroups: z.array(SyncIssueGroupSchema).nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  /** Newest first, including the run described above. */
  recentRuns: z.array(RecentSyncRunSchema),
});
export type SyncRun = z.infer<typeof SyncRunSchema>;

/**
 * "Never synced" is a normal answer, not an error (the usecase returns null).
 * A discriminated union forces the screen to handle it as an EMPTY state.
 */
export const SyncStatusResponseSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("never_synced"), tenantId: z.string().min(1) }),
  z.object({ state: z.literal("has_run"), run: SyncRunSchema }),
]);
export type SyncStatusResponse = z.infer<typeof SyncStatusResponseSchema>;

export const RunSyncResponseSchema = z.object({
  syncRunId: z.string().min(1),
  status: SyncRunStatusSchema,
  counts: SyncRunCountsSchema,
  issues: z.array(SyncIssueSchema),
  /** Always present on a fresh run — only stored history can be null. */
  issueGroups: z.array(SyncIssueGroupSchema),
  /** Sheet columns that are missing or renamed — the operator must fix these. */
  schemaDrift: z.array(z.string()),
});
export type RunSyncResponse = z.infer<typeof RunSyncResponseSchema>;

// --- Display metadata (Vietnamese labels for operators) ---------------------

export const SYNC_STATUS_LABELS: Record<SyncRunStatus, string> = {
  running: "Đang chạy",
  succeeded: "Thành công",
  partial: "Xong nhưng có vấn đề",
  failed: "Thất bại",
};

/**
 * The ONE mapping from run status to severity colour. Every block that paints a
 * run — the rail badge, the "đã chạy xong" banner — reads this: two tables would
 * drift, and an operator reads the colour before the sentence, so a green box
 * saying "Xong nhưng có vấn đề" is a lie told faster than the text can correct.
 *
 * `StatusTone` is reused from `post-batch.schema` rather than imported from the
 * Badge component: a schema is the bottom layer of the FE (docs/07 §4.1) and
 * must not depend on a component, not even for a type — `tsPreCompilationDeps`
 * counts a type-only import as a real edge. The tone is still checked against
 * the component's own union where it is consumed (`<Badge tone={…}>` in
 * `SyncRunRail`), which is the assignment that would actually break.
 */
export const SYNC_STATUS_TONES: Record<SyncRunStatus, StatusTone> = {
  running: "info",
  succeeded: "success",
  partial: "warning",
  failed: "danger",
};

export const SYNC_STATUS_HINTS: Record<SyncRunStatus, string> = {
  running: "Lần đồng bộ này chưa kết thúc. Tải lại trang sau ít phút để xem kết quả.",
  succeeded: "Toàn bộ dữ liệu đọc được đã vào hệ thống.",
  partial: "Đã ghi dữ liệu, nhưng có file và dòng bị bỏ qua — xem “Cần xử lý”.",
  failed: "Lần chạy này hỏng giữa chừng. Dữ liệu trong hệ thống vẫn là của lần đồng bộ trước.",
};

/** How serious a group of issues is — drives the dot, the bar and the wording. */
export type SyncIssueSeverity = "neutral" | "warning" | "error";

export type SyncIssueGuide = {
  severity: SyncIssueSeverity;
  /** What the operator has to DO, in Vietnamese. Never a bare restatement. */
  action: string;
};

/**
 * Guidance per `errorCode` written by the sync usecase
 * (`core/usecases/sync-catalog.ts` — SHEET_ERROR, SHEET_ROW_INVALID,
 * FILE_NAME_INVALID, PRODUCT_NOT_FOUND, MEDIA_NOT_FOUND, SOURCE_EMPTY).
 *
 * Deliberately NOT exhaustive: a new code added on the server must still show
 * up on the screen with a usable sentence rather than disappear, so
 * `syncIssueGuide` falls back instead of indexing blindly.
 */
const SYNC_ISSUE_GUIDES: Record<string, SyncIssueGuide> = {
  /**
   * Narrower than it used to be: duplicates and ambiguous names moved to their
   * own codes below. The entry stays because runs stored BEFORE that split still
   * carry this code for all three situations — history must remain readable.
   */
  FILE_NAME_INVALID: {
    severity: "error",
    action:
      "Tên file không theo chuẩn MÃSP-Màu (số) nên file bị bỏ qua — đổi tên trên Drive rồi chạy lại.",
  },
  FILE_DUPLICATE: {
    severity: "neutral",
    action:
      "Có nhiều file trùng tên; hệ thống đã giữ bản sửa gần nhất và bỏ bản cũ. Không cần làm gì.",
  },
  FILE_NEEDS_REVIEW: {
    severity: "warning",
    action:
      "File vẫn được nhận, nhưng tên chứa nhiều mã sản phẩm — mở ví dụ để kiểm tra ảnh đã gán đúng mã chưa.",
  },
  SHEET_ROW_INVALID: {
    severity: "error",
    action:
      "Dòng Sheet thiếu ô bắt buộc, hoặc hai dòng cùng mã nhưng khác dữ liệu — sửa trên Sheet rồi chạy lại.",
  },
  SHEET_ERROR: {
    severity: "error",
    action: "Cột trên Sheet bị thiếu hoặc lặp tên — sửa lại tiêu đề cột cho khớp mẫu rồi chạy lại.",
  },
  /**
   * Written by `sync-catalog` from `validateFieldMap` — the tenant's OWN column
   * mapping is questionable (a mapped header disappeared, two fields share one
   * column, a caption field points at something that looks like a price).
   *
   * Warning, not error: the run still wrote what it could read. But the fix is
   * NOT on the Sheet — it is in the mapping screen — so the sentence has to send
   * the operator to the right place, which the generic fallback never did.
   */
  FIELD_MAP_WARNING: {
    severity: "warning",
    action:
      "Ánh xạ cột của đơn vị này đang có vấn đề (cột đã đổi tên, hai trường dùng chung một cột, hoặc một cột giá bị gán vào caption) — mở “Kết nối dữ liệu” › bước “Ánh xạ cột”, chọn lại cột cho đúng rồi chạy đồng bộ lại. Xem ví dụ bên dưới để biết cột nào.",
  },
  PRODUCT_NOT_FOUND: {
    severity: "error",
    action:
      "Drive có ảnh cho mã này nhưng Sheet chưa có dòng nào — thêm dòng vào Sheet hoặc đổi tên file.",
  },
  MEDIA_NOT_FOUND: {
    severity: "warning",
    action:
      "Sheet có mã này nhưng Drive chưa có file nào khớp — tải ảnh lên rồi chạy lại. Mã này chưa đăng được.",
  },
  /**
   * The only code here that STOPS the run instead of skipping one file or row:
   * Drive answers "200, no files" for a folder the current identity cannot see,
   * and a renamed tab parses to zero rows just as quietly. `error` is the top of
   * the scale, and this one earns it — the alternative was deleting the catalog.
   */
  SOURCE_EMPTY: {
    severity: "error",
    action:
      "Thư mục Drive hoặc bảng Sheet không trả về dòng nào trong khi hệ thống đang lưu dữ liệu — đồng bộ đã dừng để không xoá nhầm sản phẩm/ảnh. Kiểm tra nguồn còn tồn tại và tài khoản đang dùng còn quyền đọc không, hoặc chọn lại nguồn; nếu nguồn rỗng thật thì phải xoá dữ liệu bằng tay.",
  },
};

const UNKNOWN_ISSUE_ACTION =
  "Mã lỗi này chưa có hướng dẫn sẵn — mở ví dụ bên dưới để biết file/dòng nào và vì sao.";

/**
 * Severity + guidance for one error code. An unknown code is never dropped and
 * never silently downgraded: the tone is inferred from the code itself, and
 * anything that does not match a known shape lands on `warning`.
 */
export function syncIssueGuide(errorCode: string): SyncIssueGuide {
  const known = SYNC_ISSUE_GUIDES[errorCode];
  if (known) return known;

  const code = errorCode.toUpperCase();
  if (code.includes("DUPLICATE")) return { severity: "neutral", action: UNKNOWN_ISSUE_ACTION };
  if (/CONFLICT|INVALID|NOT_FOUND|MISSING/.test(code)) {
    return { severity: "error", action: UNKNOWN_ISSUE_ACTION };
  }
  return { severity: "warning", action: UNKNOWN_ISSUE_ACTION };
}
