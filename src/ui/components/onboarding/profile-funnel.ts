import {
  formatPercent,
  type CatalogProfileReport,
} from "@/ui/schemas/catalog-mapping.schema";

/**
 * "Vì sao chỉ ngần này?" — the compatibility report's headline number, and the
 * chain of losses that produced it.
 *
 * The survey behind this feature ended at 20 postable codes out of 299 rows
 * (docs/05 §4). Showing "20" on its own is a number nobody can act on; showing
 * WHERE the other 279 went is what a customer and a salesperson actually sit
 * down to read. So every stage names its own loss, and a stage that lost nothing
 * still appears — a funnel with holes in it cannot be added up by eye.
 *
 * Pure module: the report is server data, this only rearranges it.
 */

export interface FunnelStage {
  readonly key: string;
  readonly label: string;
  /** The count that survived this stage. */
  readonly value: number;
  /** What was lost here, already worded for an operator. Null = nothing lost. */
  readonly loss: string | null;
}

/** The number the whole screen exists for, or null when it cannot be computed. */
export interface HeadlineNumber {
  readonly value: number | null;
  /** Why there is no number, when there is none. */
  readonly unavailableReason: string | null;
  /** True when the number was produced WITHOUT a stock check — optimistic. */
  readonly stockCheckSkipped: boolean;
}

export function headlineNumber(report: CatalogProfileReport): HeadlineNumber {
  const crossCheck = report.crossCheck;
  if (!crossCheck) {
    return {
      value: null,
      unavailableReason:
        report.driveFolderId === null
          ? "Chưa khai thư mục ảnh trên Drive, nên chưa biết mã nào có ảnh để đăng. Quay lại bước “Nguồn dữ liệu” để bổ sung."
          : "Không đọc được thư mục ảnh trên Drive, nên chưa đối chiếu được mã nào có ảnh. Xem cảnh báo bên dưới.",
      stockCheckSkipped: false,
    };
  }

  return {
    value: crossCheck.postableNow,
    unavailableReason: null,
    stockCheckSkipped: crossCheck.stockCheckSkipped,
  };
}

/**
 * The chain, in the order the pipeline walks it (CLAUDE.md business rule 1:
 * tra bảng sản phẩm -> tồn kho -> gom ảnh). Stages that depend on Drive are omitted —
 * not zeroed — when there is no Drive half: a "0 mã có ảnh" next to "chưa đọc
 * được Drive" is a number an operator would act on.
 */
export function profileFunnel(report: CatalogProfileReport): FunnelStage[] {
  const { sheet, crossCheck, media } = report;
  const stages: FunnelStage[] = [
    {
      key: "rows",
      label: "Dòng đọc được trên bảng tính",
      value: sheet.totalRows,
      loss: sheet.emptyRows > 0 ? `${sheet.emptyRows} dòng trống ở cuối bảng, bỏ qua` : null,
    },
    {
      key: "products",
      label: "Thành sản phẩm dùng được",
      value: sheet.productsParsed,
      loss: describeRowLoss(sheet.rowsRejected, sheet.duplicateCodes),
    },
  ];

  if (media) {
    stages.push({
      key: "media",
      label: "Mã có ảnh trên Drive",
      value: media.distinctCodes,
      loss:
        media.nameRejected > 0
          ? `${media.nameRejected}/${media.sampled} file không đọc được mã từ tên (đọc được ${formatPercent(media.parseRate)})`
          : null,
    });
  }

  if (crossCheck) {
    stages.push({
      key: "matched",
      label: "Mã có cả dòng lẫn ảnh",
      value: crossCheck.codesInBoth,
      loss: describeMatchLoss(crossCheck.codesOnlyInSheet, crossCheck.codesOnlyInDrive),
    });
    stages.push({
      key: "postable",
      label: "Đăng được ngay",
      value: crossCheck.postableNow,
      // The list of CAUSES depends on the policy: with the gate off, "ô tồn
      // trống" is no longer one of them, and naming it would send an operator
      // to fix a cell that is not the reason.
      loss:
        crossCheck.blockedByInventory > 0
          ? `${crossCheck.blockedByInventory} mã bị chặn: ${describeBlockCauses(crossCheck.stockCheckSkipped)}`
          : null,
    });
  }

  return stages;
}

/**
 * What can still block a matched code, per policy. The sold-out note and the
 * row-conflict rule run in ALL THREE modes — only the numeric checks disappear
 * when the tenant turns the stock gate off.
 */
function describeBlockCauses(stockCheckSkipped: boolean): string {
  return stockCheckSkipped
    ? "ô Lưu ý ghi “HẾT HÀNG”, hoặc bảng có hai dòng cùng mã mà khác dữ liệu. Số tồn không còn được kiểm cho đơn vị này."
    : "hết hàng, ô tồn trống hoặc không phải số, hoặc bảng có hai dòng cùng mã mà khác dữ liệu.";
}

function describeRowLoss(rowsRejected: number, duplicateCodes: number): string | null {
  const parts: string[] = [];
  if (rowsRejected > 0) parts.push(`${rowsRejected} dòng bị loại (thiếu mã hoặc thiếu tên)`);
  if (duplicateCodes > 0) parts.push(`${duplicateCodes} dòng trùng mã đã gộp vào dòng trước`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

function describeMatchLoss(onlyInSheet: number, onlyInDrive: number): string | null {
  const parts: string[] = [];
  if (onlyInSheet > 0) parts.push(`${onlyInSheet} mã có dòng nhưng chưa có ảnh`);
  if (onlyInDrive > 0) parts.push(`${onlyInDrive} mã có ảnh nhưng chưa có dòng trên bảng tính`);
  return parts.length > 0 ? parts.join(" · ") : null;
}
