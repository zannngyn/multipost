import { formatCount } from "@/ui/components/sync/sync-format";
import type { SyncRunCounts } from "@/ui/schemas/sync.schema";

/**
 * The arithmetic of the funnel, kept pure and JSX-free: the component only lays
 * these values out.
 *
 * `leftover` is not padding. On the Sheet stage, rows that are neither rejected
 * nor a new product are empty trailing rows and rows merged into a code already
 * seen; without that segment the bar would claim a total it does not account
 * for. `Math.max(0, …)` is the guard for the day a count arrives inconsistent —
 * a negative segment would render as an overflowing bar, not as an error.
 */

export type SegmentTone = "kept" | "neutral" | "rejected";

export type Segment = {
  key: string;
  label: string;
  value: number;
  tone: SegmentTone;
};

/** One "N <label>" fact in the trailing note of a stage. */
export type StageFact = {
  key: string;
  value: number;
  label: string;
};

export type Stage = {
  ordinal: string;
  title: string;
  /** Everything that entered this stage — the denominator of the bar. */
  total: number;
  totalLabel: string;
  /** Empty-input wording, because 0 out of 0 is not "0%". */
  emptyLabel: string;
  forwardValue: number;
  forwardLabel: string;
  segments: Segment[];
  facts: StageFact[];
};

export function buildStages(counts: SyncRunCounts): Stage[] {
  const driveLeftover = Math.max(
    0,
    counts.driveFilesSeen -
      counts.mediaParsed -
      counts.mediaDuplicatesDropped -
      counts.mediaRejected,
  );
  const sheetLeftover = Math.max(
    0,
    counts.sheetRowsSeen - counts.productsParsed - counts.sheetRowsRejected,
  );

  const driveSegments: Segment[] = [
    { key: "kept", label: "Đọc được", value: counts.mediaParsed, tone: "kept" },
    {
      key: "duplicates",
      label: "Trùng đã bỏ",
      value: counts.mediaDuplicatesDropped,
      tone: "neutral",
    },
    { key: "rejected", label: "Bị loại", value: counts.mediaRejected, tone: "rejected" },
  ];
  if (driveLeftover > 0) {
    driveSegments.push({
      key: "leftover",
      label: "Không xếp được nhóm",
      value: driveLeftover,
      tone: "neutral",
    });
  }

  const sheetSegments: Segment[] = [
    { key: "kept", label: "Đọc được", value: counts.productsParsed, tone: "kept" },
    { key: "rejected", label: "Dòng bị loại", value: counts.sheetRowsRejected, tone: "rejected" },
  ];
  if (sheetLeftover > 0) {
    sheetSegments.push({
      key: "leftover",
      label: "Dòng trống hoặc gộp vào mã đã có",
      value: sheetLeftover,
      tone: "neutral",
    });
  }

  return [
    {
      ordinal: "01",
      title: "Ảnh / video Drive",
      total: counts.driveFilesSeen,
      totalLabel: `${formatCount(counts.driveFilesSeen)} file quét`,
      emptyLabel: "Thư mục Drive không có file nào trong lần chạy này.",
      forwardValue: counts.mediaParsed,
      forwardLabel: "file đi tiếp",
      segments: driveSegments,
      facts: [
        // `mediaWithoutProduct` counts CODES, not files (sync-catalog.ts:
        // `codesWithoutProduct.length`) — the wording has to say so, otherwise
        // the number reads as a file count and never adds up against the bar.
        { key: "no-sheet-row", value: counts.mediaWithoutProduct, label: "mã không có trên Sheet" },
        { key: "needs-review", value: counts.mediaNeedingReview, label: "file cần rà soát" },
      ],
    },
    {
      ordinal: "02",
      title: "Sản phẩm Sheet",
      total: counts.sheetRowsSeen,
      totalLabel: `${formatCount(counts.sheetRowsSeen)} dòng`,
      emptyLabel: "Tab Sheet không có dòng dữ liệu nào trong lần chạy này.",
      forwardValue: counts.productsParsed,
      forwardLabel: "sản phẩm đi tiếp",
      segments: sheetSegments,
      facts: [
        { key: "conflict", value: counts.productsWithConflict, label: "mã mâu thuẫn dữ liệu" },
        { key: "no-media", value: counts.productsWithoutMedia, label: "sản phẩm chưa có ảnh" },
      ],
    },
  ];
}
