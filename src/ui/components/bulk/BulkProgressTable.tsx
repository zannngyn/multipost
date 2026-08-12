"use client";

import Link from "next/link";

import { Badge } from "@/ui/components/ui/badge";
import {
  BULK_ROW_STATUS_LABELS,
  BULK_ROW_STATUS_TONES,
} from "@/ui/schemas/bulk.schema";
import type { BulkRunRow } from "@/ui/hooks/useBulkRun";

/**
 * Per-code progress of a bulk run (E10.5).
 *
 * One row per code, updated as the loop walks the list — a spinner over the
 * whole thing would hide exactly the information that matters: WHICH code was
 * skipped and WHY (core-bulk-actions §Thất bại một phần).
 *
 * Business rule 2: this table shows the product code and name, the outcome and
 * a link to the batch. Never stock, never price — the reason sentence comes
 * from the server and is written for operators.
 *
 * Presentational: no fetching, no business branching.
 */
export function BulkProgressTable({ rows }: { rows: readonly BulkRunRow[] }) {
  return (
    <div className="overflow-x-auto rounded-xl border">
      <table className="w-full min-w-160 border-collapse text-sm">
        <caption className="sr-only">
          Tiến độ chạy hàng loạt: trạng thái từng mã sản phẩm và lô đăng đã tạo
        </caption>
        <thead className="bg-muted/50">
          <tr className="text-left">
            <th scope="col" className="px-3 py-2 font-medium">
              #
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Mã sản phẩm
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Sản phẩm
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Trạng thái
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Lý do / ghi chú
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Lô đăng
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={`${row.code}-${index}`} className="border-t align-top">
              <td className="text-muted-foreground px-3 py-2 tabular-nums">{index + 1}</td>
              <td className="px-3 py-2 font-mono text-xs break-all">{row.code}</td>
              <td className="px-3 py-2">{row.productName ?? "—"}</td>
              <td className="px-3 py-2">
                <Badge tone={BULK_ROW_STATUS_TONES[row.status]}>
                  {BULK_ROW_STATUS_LABELS[row.status]}
                </Badge>
              </td>
              <td className="px-3 py-2">
                {row.reason ? (
                  <span className="max-w-prose break-words">{row.reason}</span>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
                {row.errorCode ? (
                  <span className="text-muted-foreground block font-mono text-xs">
                    Mã lỗi: {row.errorCode}
                  </span>
                ) : null}
              </td>
              <td className="px-3 py-2">
                {row.batchId ? (
                  <Link
                    href={`/batches/${encodeURIComponent(row.batchId)}`}
                    className="underline underline-offset-4"
                  >
                    Xem lô ({row.channelCount} kênh)
                  </Link>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
