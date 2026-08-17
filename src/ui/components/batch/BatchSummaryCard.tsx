import { BatchStatusBadge } from "@/ui/components/post/PostStatusBadge";
import {
  formatDateTime,
  formatDurationMs,
  type BatchStatusResponse,
} from "@/ui/schemas/post-batch.schema";

/**
 * Batch header: what happened, to which product, and how long it took.
 * Presentational only.
 *
 * Business rule 2: the product CODE and colour are identity, not caption
 * material — and stock/price have no field here at all. Rule 6: `partial` is
 * shown as its own outcome, never softened into "xong".
 */

/**
 * "Facebook giữ lịch" is its own tile even though it is already counted inside
 * "Đang chạy": a batch that sits at 0 published for three days is alarming until
 * you can see that Facebook is holding the posts until their hour (E8.6).
 */
const TOTALS_FIELDS = [
  { key: "total", label: "Tổng số kênh" },
  { key: "published", label: "Đã đăng" },
  { key: "inProgress", label: "Đang chạy" },
  { key: "scheduledOnFacebook", label: "Facebook giữ lịch" },
  { key: "blocked", label: "Bị chặn" },
  { key: "failed", label: "Lỗi" },
] as const;

export function BatchSummaryCard({ batch }: { batch: BatchStatusResponse }) {
  return (
    <section aria-labelledby="batch-summary-heading" className="bg-card space-y-4 rounded-xl border p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="batch-summary-heading" className="text-base font-semibold">
          Tổng kết lô
        </h2>
        <BatchStatusBadge status={batch.status} />
      </div>

      <p className="text-sm">{batch.summaryMessage}</p>

      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {TOTALS_FIELDS.map((field) => (
          <div key={field.key} className="bg-muted/40 rounded-lg border p-3">
            <dt className="text-muted-foreground text-xs">{field.label}</dt>
            <dd className="text-lg font-semibold tabular-nums">{batch.totals[field.key]}</dd>
          </div>
        ))}
      </dl>

      <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
        <div className="flex gap-2">
          <dt className="text-muted-foreground">Mã sản phẩm:</dt>
          <dd className="font-medium">{batch.productCode}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="text-muted-foreground">Màu:</dt>
          <dd>{batch.color.trim().length > 0 ? batch.color : "Tất cả màu"}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="text-muted-foreground">Bắt đầu:</dt>
          <dd className="tabular-nums">{formatDateTime(batch.startedAt)}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="text-muted-foreground">Kết thúc:</dt>
          <dd className="tabular-nums">
            {batch.finishedAt ? formatDateTime(batch.finishedAt) : "— (chưa xong)"}
          </dd>
        </div>
        {batch.durationMs !== null ? (
          <div className="flex gap-2">
            <dt className="text-muted-foreground">Thời gian chạy:</dt>
            <dd className="tabular-nums">{formatDurationMs(batch.durationMs)}</dd>
          </div>
        ) : null}
        <div className="flex gap-2">
          <dt className="text-muted-foreground">Mã lô:</dt>
          <dd className="font-mono text-xs break-all">{batch.batchId}</dd>
        </div>
      </dl>
    </section>
  );
}
