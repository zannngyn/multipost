"use client";

import Link from "next/link";

import { TableScrollRegion } from "@/ui/components/posts/TableScrollRegion";
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
 * Status is a dye + its NAME, never the dye alone (The Named Status Rule): the
 * tone mapping lives in `bulk.schema` beside the labels, so a status can never
 * gain a colour without gaining a word. `info` for the three in-flight states is
 * deliberate — Fact Blue does not take part in the tint game (The 10% Tint
 * Rule), so "đang chạy" stays a plain surface and only the three outcomes
 * (madder / turmeric / leaf) carry a dyed background.
 *
 * Business rule 2: this table shows the product code and name, the outcome and
 * a link to the batch. Never stock, never price — the reason sentence comes
 * from the server and is written for operators.
 *
 * Presentational: no fetching, no business branching.
 */
export function BulkProgressTable({ rows }: { rows: readonly BulkRunRow[] }) {
  return (
    // The SAME scroll frame as the log and the schedule (ruling T3): one
    // pattern for "this table is wider than its box", so an operator learns the
    // soft edge once and reads it on every table in the app. It replaces the
    // sentence this table used to print under itself — that cue was container-
    // queried at 40rem, i.e. it appeared at a width guessed from `min-w-160`
    // rather than from whether the table is REALLY overflowing, and it said in
    // words what the shared cue says on the edge that actually has content
    // behind it, on both sides, with no breakpoint to keep in sync.
    <TableScrollRegion aria-label="Bảng tiến độ chạy hàng loạt, cuộn ngang được">
      <table className="w-full min-w-160 border-collapse text-sm">
        <caption className="sr-only">
          Tiến độ chạy hàng loạt: trạng thái từng mã sản phẩm và lô đăng đã tạo
        </caption>
        {/* Declared widths, not content-driven ones: every cell of this table
            fills in WHILE the run walks the list, and columns that resize on
            each row would make the whole table twitch (web-data-table §1). */}
        <colgroup>
          <col className="w-[6%]" />
          <col className="w-[16%]" />
          <col className="w-[20%]" />
          <col className="w-[14%]" />
          <col className="w-[30%]" />
          <col className="w-[14%]" />
        </colgroup>
        <thead className="bg-muted/50">
          <tr className="text-left">
            <th scope="col" className="px-3 py-2 font-medium whitespace-nowrap">
              #
            </th>
            <th scope="col" className="px-3 py-2 font-medium whitespace-nowrap">
              Mã sản phẩm
            </th>
            <th scope="col" className="px-3 py-2 font-medium whitespace-nowrap">
              Sản phẩm
            </th>
            <th scope="col" className="px-3 py-2 font-medium whitespace-nowrap">
              Trạng thái
            </th>
            <th scope="col" className="px-3 py-2 font-medium whitespace-nowrap">
              Lý do / ghi chú
            </th>
            <th scope="col" className="px-3 py-2 font-medium whitespace-nowrap">
              Lô đăng
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={`${row.code}-${index}`} className="border-border border-t align-top">
              <td className="text-foreground-subtle px-3 py-2.5 font-mono text-xs tabular-nums">
                {index + 1}
              </td>
              {/* The Mono Ledger Rule, and nowrap: a product code broken across
                  two lines is a different string to the eye reading it back to
                  the Sheet. */}
              <td className="px-3 py-2.5 font-mono text-xs whitespace-nowrap">{row.code}</td>
              <td className="px-3 py-2.5">{row.productName ?? "—"}</td>
              <td className="px-3 py-2.5">
                <Badge tone={BULK_ROW_STATUS_TONES[row.status]}>
                  {BULK_ROW_STATUS_LABELS[row.status]}
                </Badge>
              </td>
              <td className="px-3 py-2.5">
                {row.reason ? (
                  <span className="max-w-prose break-words">{row.reason}</span>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
                {row.errorCode ? (
                  <span className="text-foreground-subtle block font-mono text-xs">
                    Mã lỗi: {row.errorCode}
                  </span>
                ) : null}
              </td>
              <td className="px-3 py-2.5">
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
    </TableScrollRegion>
  );
}
