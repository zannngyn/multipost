import { Badge } from "@/ui/components/ui/badge";
import type { SyncIssue } from "@/ui/schemas/sync.schema";

/**
 * The list that answers "vì sao tấm ảnh này không có trong bài?" without
 * opening a log file (business rule 5). Presentational only.
 *
 * `truncated` is not a detail: a run may detect 3.491 issues and store 200. The
 * screen must say so, otherwise the operator fixes 200 problems and believes
 * the catalogue is clean.
 */
export function SyncIssuesTable({
  issues,
  total,
  truncated,
}: {
  issues: readonly SyncIssue[];
  /** Uncapped number detected by the run (`counts.issuesTotal`). */
  total: number;
  truncated: boolean;
}) {
  return (
    <section aria-labelledby="sync-issues-heading" className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 id="sync-issues-heading" className="text-base font-semibold">
          Vấn đề ghi nhận trong lần đồng bộ này
        </h3>
        <p className="text-muted-foreground text-sm tabular-nums">
          {total.toLocaleString("vi-VN")} vấn đề
        </p>
      </div>

      {truncated ? (
        <p
          role="status"
          className="border-warning/40 bg-warning/10 text-warning-foreground rounded-lg border px-3 py-2 text-sm"
        >
          Hiển thị {issues.length.toLocaleString("vi-VN")}/{total.toLocaleString("vi-VN")} vấn đề —
          danh sách đã bị cắt bớt để không làm nặng hệ thống. Xử lý xong nhóm này rồi chạy đồng bộ
          lại để xem phần còn lại.
        </p>
      ) : null}

      {issues.length === 0 ? (
        <p className="text-muted-foreground bg-muted/30 rounded-lg border border-dashed p-4 text-sm">
          Không có file hay dòng nào bị bỏ qua. Toàn bộ dữ liệu đọc được đã vào hệ thống.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-xl border">
          <table className="w-full border-collapse text-sm">
            <caption className="sr-only">
              Danh sách file và dòng Sheet bị bỏ qua, kèm lý do
            </caption>
            <thead className="bg-muted/50">
              <tr className="text-left">
                <th scope="col" className="px-3 py-2 font-medium">
                  Loại
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Lý do
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  File / dòng
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Chi tiết
                </th>
              </tr>
            </thead>
            <tbody>
              {issues.map((issue, index) => (
                <tr
                  key={`${issue.ref}-${issue.reason}-${index}`}
                  className="border-t align-top"
                >
                  <td className="px-3 py-2">
                    <Badge tone="warning">{issue.errorCode}</Badge>
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">{issue.reason}</td>
                  <td className="px-3 py-2 break-all">{issue.ref}</td>
                  <td className="text-muted-foreground px-3 py-2">{issue.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
