import { z } from "zod";

import type { StatusTone } from "./post-batch.schema";
import { tenantIdField } from "./tenant-health.schema";

/**
 * Contracts of the "Đồng bộ dữ liệu" screen (E2 read model + trigger).
 *
 * `ui/` may not import `core/` (one-way dependency law, docs/07 §2), so these
 * schemas MIRROR `core/ports/product-repo.ts` (SyncIssue, SyncRunCounts,
 * SyncRunSummary) and `core/usecases/sync-catalog.ts` (SyncCatalogResult).
 * Any change there must be reflected here — the mirror is deliberate, and the
 * runtime parse in `http-client` is what makes a drift loud instead of silent.
 */

export const SyncFormSchema = z.object({ tenantId: tenantIdField() });
export type SyncFormValues = z.infer<typeof SyncFormSchema>;

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
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
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
 * FILE_NAME_INVALID, PRODUCT_NOT_FOUND, MEDIA_NOT_FOUND).
 *
 * Deliberately NOT exhaustive: a new code added on the server must still show
 * up on the screen with a usable sentence rather than disappear, so
 * `syncIssueGuide` falls back instead of indexing blindly.
 */
const SYNC_ISSUE_GUIDES: Record<string, SyncIssueGuide> = {
  FILE_NAME_INVALID: {
    severity: "warning",
    action:
      "Tên file không theo chuẩn MÃSP-Màu (số), hoặc là bản trùng đã bị bỏ — đổi tên trên Drive rồi chạy lại.",
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
