import { Badge, type BadgeTone } from "@/ui/components/ui/badge";
import { SYNC_STATUS_LABELS, type SyncRun, type SyncRunStatus } from "@/ui/schemas/sync.schema";

/**
 * Header of the latest run: status, timing, and the failure reason when there
 * is one. Presentational only.
 *
 * `partial` deliberately does NOT look like `succeeded`: the run finished, but
 * files were skipped and somebody has to look at them.
 */
const STATUS_TONE: Record<SyncRunStatus, BadgeTone> = {
  running: "info",
  succeeded: "success",
  partial: "warning",
  failed: "danger",
};

const STATUS_HINT: Record<SyncRunStatus, string> = {
  running: "Lần đồng bộ này chưa kết thúc. Tải lại trang sau ít phút để xem kết quả.",
  succeeded: "Toàn bộ dữ liệu đọc được đã vào hệ thống.",
  partial: "Đã ghi dữ liệu, nhưng có file/dòng bị bỏ qua — xem danh sách vấn đề bên dưới.",
  failed: "Lần chạy này hỏng giữa chừng. Dữ liệu trong hệ thống vẫn là của lần đồng bộ trước.",
};

function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat("vi-VN", { dateStyle: "short", timeStyle: "medium" }).format(date);
}

function formatDuration(startedAt: string, finishedAt: string | null): string | null {
  if (!finishedAt) return null;
  const ms = new Date(finishedAt).getTime() - new Date(startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1_000) return `${ms} ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} giây`;
  return `${Math.floor(seconds / 60)} phút ${seconds % 60} giây`;
}

export function SyncRunSummary({ run }: { run: SyncRun }) {
  const duration = formatDuration(run.startedAt, run.finishedAt);

  return (
    <div className="bg-card space-y-3 rounded-xl border p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-base font-semibold">Lần đồng bộ gần nhất</h2>
        <Badge tone={STATUS_TONE[run.status]}>{SYNC_STATUS_LABELS[run.status]}</Badge>
      </div>

      <p className="text-muted-foreground text-sm">{STATUS_HINT[run.status]}</p>

      <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
        <div className="flex gap-2">
          <dt className="text-muted-foreground">Bắt đầu:</dt>
          <dd className="tabular-nums">{formatDateTime(run.startedAt)}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="text-muted-foreground">Kết thúc:</dt>
          <dd className="tabular-nums">
            {run.finishedAt ? formatDateTime(run.finishedAt) : "— (chưa xong)"}
          </dd>
        </div>
        {duration ? (
          <div className="flex gap-2">
            <dt className="text-muted-foreground">Thời gian chạy:</dt>
            <dd className="tabular-nums">{duration}</dd>
          </div>
        ) : null}
        <div className="flex gap-2">
          <dt className="text-muted-foreground">Mã lần chạy:</dt>
          <dd className="font-mono text-xs break-all">{run.syncRunId}</dd>
        </div>
      </dl>

      {run.errorCode || run.errorMessage ? (
        <p
          role="alert"
          className="border-destructive/30 bg-destructive/5 text-destructive rounded-lg border px-3 py-2 text-sm"
        >
          <span className="font-medium">Lý do dừng:</span> {run.errorMessage ?? "Không rõ"}
          {run.errorCode ? <span className="font-mono text-xs"> ({run.errorCode})</span> : null}
        </p>
      ) : null}
    </div>
  );
}
