"use client";

import {
  HStack,
  Link,
  Stack,
  StatusDot,
  Table,
  Text,
  pixel,
  proportional,
} from "@astryxdesign/core";
import type { TableColumn } from "@astryxdesign/core";

import {
  BULK_ROW_STATUS_LABELS,
  BULK_ROW_STATUS_TONES,
} from "@/ui/schemas/bulk.schema";
import type { StatusTone } from "@/ui/schemas/post-batch.schema";
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

/**
 * [dup-2/3] Same three-line map as `BatchChannelTable`. The DECISION (status ->
 * tone) still lives once, in the schemas; only this rendering detail is copied,
 * and the shared pill component that would hold it (`post/PostStatusBadge`)
 * belongs to another screen's scope. Third copy → extract it.
 */
const DOT_VARIANT: Record<StatusTone, "success" | "warning" | "error" | "accent" | "neutral"> = {
  neutral: "neutral",
  info: "accent",
  success: "success",
  warning: "warning",
  danger: "error",
};

/** Table's generic needs an index signature; the ordinal is display-only. */
type ProgressRow = BulkRunRow & { ordinal: number } & Record<string, unknown>;

const COLUMNS: TableColumn<ProgressRow>[] = [
  {
    key: "ordinal",
    header: "#",
    width: pixel(56),
    align: "end",
    renderCell: (row) => (
      <Text type="supporting" hasTabularNumbers>
        {row.ordinal}
      </Text>
    ),
  },
  {
    key: "code",
    header: "Mã sản phẩm",
    width: pixel(160),
    renderCell: (row) => <Text type="code">{row.code}</Text>,
  },
  {
    key: "productName",
    header: "Sản phẩm",
    width: proportional(2),
    renderCell: (row) =>
      row.productName ? (
        <Text>{row.productName}</Text>
      ) : (
        // Not yet known: the loop learns the name when it reaches the code.
        <Text color="placeholder">—</Text>
      ),
  },
  {
    key: "status",
    header: "Trạng thái",
    width: pixel(180),
    renderCell: (row) => {
      const label = BULK_ROW_STATUS_LABELS[row.status];
      return (
        <HStack gap={2} align="center">
          {/* Colour never carries the meaning alone — the word is right next
              to the dot, and the dot repeats it as its accessible name. */}
          <StatusDot variant={DOT_VARIANT[BULK_ROW_STATUS_TONES[row.status]]} label={label} />
          <Text>{label}</Text>
        </HStack>
      );
    },
  },
  {
    key: "reason",
    header: "Lý do / ghi chú",
    width: proportional(3),
    renderCell: (row) => (
      <Stack direction="vertical" gap={0.5}>
        {row.reason ? <Text>{row.reason}</Text> : <Text color="placeholder">—</Text>}
        {row.errorCode ? (
          // Small and secondary: it is the string support asks for, not the
          // sentence the operator acts on.
          <Text type="code" size="2xs" color="secondary">
            Mã lỗi: {row.errorCode}
          </Text>
        ) : null}
      </Stack>
    ),
  },
  {
    key: "batchId",
    header: "Lô đăng",
    width: pixel(180),
    renderCell: (row) =>
      row.batchId ? (
        <Link href={`/batches/${encodeURIComponent(row.batchId)}`}>
          Xem lô ({row.channelCount} kênh)
        </Link>
      ) : (
        <Text color="placeholder">—</Text>
      ),
  },
];

export function BulkProgressTable({ rows }: { rows: readonly BulkRunRow[] }) {
  const data: ProgressRow[] = rows.map((row, index) => ({ ...row, ordinal: index + 1 }));

  return (
    <Table
      data={data}
      columns={COLUMNS}
      // The same code may legitimately appear twice in a run list, so the
      // ordinal is what makes a row unique.
      idKey={(row) => `${row.code}-${row.ordinal}`}
      density="compact"
      // Reasons are full sentences: wrapping keeps them readable instead of
      // hiding the half that says what to do.
      textOverflow="wrap"
      verticalAlign="top"
      hasHover
      rowCount={data.length}
    />
  );
}
