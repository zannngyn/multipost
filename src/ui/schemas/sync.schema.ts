import { z } from "zod";

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

/** Counts grouped the way an operator reads them: nguồn → kết quả ghi. */
export const SYNC_COUNT_GROUPS: readonly {
  title: string;
  items: readonly { key: keyof SyncRunCounts; label: string; tone?: "warn" }[];
}[] = [
  {
    title: "Ảnh / video trên Drive",
    items: [
      { key: "driveFilesSeen", label: "File đã quét" },
      { key: "mediaParsed", label: "File đọc được" },
      { key: "mediaRejected", label: "File bị loại", tone: "warn" },
      { key: "mediaDuplicatesDropped", label: "File trùng đã bỏ", tone: "warn" },
      { key: "mediaNeedingReview", label: "File cần rà soát", tone: "warn" },
      { key: "mediaWithoutProduct", label: "File không khớp mã nào", tone: "warn" },
    ],
  },
  {
    title: "Sản phẩm trên Sheet",
    items: [
      { key: "sheetRowsSeen", label: "Dòng đã đọc" },
      { key: "productsParsed", label: "Sản phẩm đọc được" },
      { key: "sheetRowsRejected", label: "Dòng bị loại", tone: "warn" },
      { key: "productsWithConflict", label: "Mã mâu thuẫn dữ liệu", tone: "warn" },
      { key: "productsWithoutMedia", label: "Sản phẩm chưa có ảnh", tone: "warn" },
    ],
  },
  {
    title: "Ghi vào hệ thống",
    items: [
      { key: "productsWritten", label: "Sản phẩm đã ghi" },
      { key: "mediaWritten", label: "File đã ghi" },
      { key: "productsDeleted", label: "Sản phẩm đã xoá" },
      { key: "mediaDeleted", label: "File đã xoá" },
    ],
  },
];
