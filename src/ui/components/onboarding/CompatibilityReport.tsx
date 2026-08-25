"use client";

import {
  Badge,
  Banner,
  Divider,
  HStack,
  Heading,
  Item,
  Section,
  Stack,
  Text,
} from "@astryxdesign/core";
import { Fragment } from "react";
import {
  CheckCircle2,
  AlertTriangle,
  FileSpreadsheet,
  Image as ImageIcon,
  Boxes,
  HelpCircle,
  Sparkles,
  ArrowDownRight,
  TrendingDown,
} from "lucide-react";

import { StockCheckSkippedBanner } from "@/ui/components/inventory/StockCheckSkippedBanner";
import { headlineNumber, profileFunnel } from "@/ui/components/onboarding/profile-funnel";
import {
  CATALOG_FIELD_LABELS,
  formatPercent,
  type CatalogProfileReport,
} from "@/ui/schemas/catalog-mapping.schema";

export function CompatibilityReport({
  report,
  headingLevel = 2,
}: {
  report: CatalogProfileReport;
  headingLevel?: 2 | 3;
}) {
  const headline = headlineNumber(report);
  const stages = profileFunnel(report);
  const mapIssues = report.fieldMap.issues;

  const totalProducts = report.sheet.productsParsed || report.sheet.totalRows || 0;
  const postableCount = headline.value ?? 0;
  const postableRate = totalProducts > 0 ? Math.round((postableCount / totalProducts) * 100) : 0;

  return (
    <div className="flex flex-col gap-6">
      {/* 1. Hero Stat Headline Card */}
      <div className="relative overflow-hidden rounded-xl border border-border/80 bg-card p-6 shadow-xs">
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-2">
            <p className="font-mono text-xs font-semibold uppercase tracking-widest text-muted-foreground">
              BÁO CÁO TƯƠNG THÍCH DỮ LIỆU
            </p>
            {headline.value !== null && (
              <span
                className={`rounded-full px-2.5 py-0.5 font-mono text-xs font-medium ${
                  postableRate >= 80
                    ? "bg-leaf/20 text-leaf-deep"
                    : postableRate >= 40
                      ? "bg-turmeric/20 text-turmeric-deep"
                      : "bg-madder/20 text-madder"
                }`}
              >
                Tỷ lệ sẵn sàng: {postableRate}%
              </span>
            )}
          </div>

          <div className="flex flex-wrap items-baseline gap-3">
            {headline.value === null ? (
              <span className="text-2xl font-semibold text-muted-foreground">
                Chưa tính được số mã
              </span>
            ) : (
              <>
                <span className="font-mono text-4xl font-bold tracking-tight text-foreground md:text-5xl tabular-nums">
                  {headline.value.toLocaleString("vi-VN")}
                </span>
                <span className="text-base text-muted-foreground">
                  mã hợp lệ sẵn sàng đăng ngay trên{" "}
                  <strong className="font-mono text-foreground font-semibold">
                    {report.sheet.productsParsed.toLocaleString("vi-VN")}
                  </strong>{" "}
                  mã đọc được từ bảng tính
                </span>
              </>
            )}
          </div>

          <p className="text-xs leading-relaxed text-muted-foreground max-w-2xl">
            {headline.unavailableReason ??
              (headline.stockCheckSkipped
                ? "Số mã có đủ dữ liệu trên bảng và tìm thấy ảnh trên Drive. Bạn đang tắt kiểm tồn nên số lượng tồn chưa được trừ — kết quả này có thể cao hơn thực tế."
                : "Số mã có đầy đủ tên, mã sản phẩm, vượt qua kiểm tra tồn kho và đã tìm thấy ảnh tương ứng trên Google Drive.")}
          </p>
        </div>
      </div>

      {headline.stockCheckSkipped ? <StockCheckSkippedBanner reason={null} /> : null}

      {/* 2. Visual Pipeline / Funnel */}
      <div className="flex flex-col gap-3 rounded-xl border border-border/80 bg-card p-5 shadow-xs">
        <div className="flex items-center justify-between border-b border-border/60 pb-3">
          <div className="flex items-center gap-2">
            <TrendingDown className="size-4 text-primary" />
            <h3 className="text-sm font-semibold text-foreground">
              Quy trình lọc dữ liệu (Vì sao chỉ ngần này mã)
            </h3>
          </div>
          <span className="text-xs text-muted-foreground">Phân tích từng giai đoạn</span>
        </div>

        <div className="flex flex-col divide-y divide-border/60">
          {stages.map((stage, idx) => (
            <div key={stage.key} className="flex flex-col gap-1.5 py-3 first:pt-1 last:pb-1">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <span className="flex size-5 items-center justify-center rounded-full bg-muted font-mono text-[10px] font-semibold text-muted-foreground">
                    {idx + 1}
                  </span>
                  <span className="text-sm font-medium text-foreground">{stage.label}</span>
                </div>
                <span className="font-mono text-base font-semibold text-foreground tabular-nums">
                  {stage.value.toLocaleString("vi-VN")}
                </span>
              </div>

              {stage.loss ? (
                <div className="flex items-center gap-1.5 pl-7 text-xs text-turmeric-deep">
                  <ArrowDownRight className="size-3.5 shrink-0" />
                  <span>{stage.loss}</span>
                </div>
              ) : (
                <p className="pl-7 text-xs text-muted-foreground">
                  Không bị mất mã nào ở giai đoạn này.
                </p>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* 3. Mapping Issues (if any) */}
      {mapIssues.length > 0 && (
        <div className="flex flex-col gap-3 rounded-xl border border-madder/30 bg-madder/10 p-5">
          <div className="flex items-center gap-2 text-madder font-semibold text-sm">
            <AlertTriangle className="size-4" />
            <span>Cần kiểm tra lại ánh xạ cột</span>
          </div>
          <div className="flex flex-col gap-2">
            {mapIssues.map((issue) => (
              <div
                key={`${issue.code}-${issue.column ?? issue.fields.join(",")}`}
                className="flex flex-col gap-0.5 rounded-lg border border-madder/20 bg-card p-3"
              >
                <span className="text-xs font-semibold text-foreground">
                  {issue.fields.map((field) => CATALOG_FIELD_LABELS[field]).join(" · ")}
                </span>
                <p className="text-xs text-muted-foreground">{issue.detail}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 4. Top Issues To Fix */}
      <div className="flex flex-col gap-3 rounded-xl border border-border/80 bg-card p-5 shadow-xs">
        <div className="flex items-center justify-between border-b border-border/60 pb-3">
          <h3 className="text-sm font-semibold text-foreground">Những việc cần xử lý nhất</h3>
          <span className="font-mono text-xs text-muted-foreground">
            {report.topIssues.length} nhóm vấn đề
          </span>
        </div>

        {report.topIssues.length === 0 ? (
          <div className="flex items-center gap-2 py-4 text-xs text-leaf-deep">
            <CheckCircle2 className="size-4" />
            <span>Dữ liệu rất chuẩn! Không có lỗi nào đáng kể làm gián đoạn việc đăng bài.</span>
          </div>
        ) : (
          <div className="flex flex-col divide-y divide-border/60">
            {report.topIssues.map((issue) => (
              <div key={issue.reason} className="flex flex-col gap-1 py-3 first:pt-1 last:pb-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium text-foreground">{issue.detail}</span>
                  <span className="rounded-full bg-muted px-2 py-0.5 font-mono text-xs font-semibold text-muted-foreground tabular-nums">
                    {issue.count} mã
                  </span>
                </div>
                {issue.examples.length > 0 && (
                  <p className="font-mono text-[11px] text-muted-foreground">
                    Ví dụ các mã gặp lỗi: {issue.examples.join(", ")}
                    {issue.count > issue.examples.length ? " …" : ""}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 5. Sheet & Column Inventory Facts */}
      <div className="flex flex-col gap-3 rounded-xl border border-border/80 bg-card p-5 shadow-xs">
        <div className="flex items-center justify-between border-b border-border/60 pb-3">
          <div className="flex items-center gap-2">
            <FileSpreadsheet className="size-4 text-primary" />
            <h3 className="text-sm font-semibold text-foreground">
              Thông tin bảng tính đã quét
            </h3>
          </div>
          <span className="font-mono text-xs text-muted-foreground">
            Tab “{report.sheetName}”
          </span>
        </div>

        <div className="flex flex-col gap-2.5 text-xs text-muted-foreground">
          <p>
            Đã đọc{" "}
            <strong className="font-mono text-foreground font-semibold">
              {report.sheet.columns.length} cột
            </strong>{" "}
            và{" "}
            <strong className="font-mono text-foreground font-semibold">
              {report.sheet.totalRows.toLocaleString("vi-VN")} dòng
            </strong>
            .
            {report.media
              ? ` Thư mục ảnh Drive: quét ${report.media.sampled} file${
                  report.media.capped ? " (lấy mẫu)" : ""
                }, tỷ lệ đọc được mã từ file đạt ${formatPercent(report.media.parseRate)}.`
              : " Chưa liên kết thư mục ảnh Drive."}
          </p>

          <div className="flex flex-wrap gap-1.5 pt-1">
            {report.sheet.columns.map((column) => (
              <span
                key={column}
                className="rounded-md border border-border/80 bg-muted/40 px-2 py-1 font-mono text-[11px] text-foreground"
              >
                {column}
              </span>
            ))}
          </div>

          {report.fieldMap.priceLikeColumns.length > 0 && (
            <p className="text-[11px] text-turmeric-deep pt-1">
              * Cột trông như giá và không đưa vào caption:{" "}
              {report.fieldMap.priceLikeColumns.join(", ")}
            </p>
          )}

          {report.sheet.conflictingCodes.length > 0 && (
            <p className="text-[11px] text-madder pt-1">
              * Có {report.sheet.conflictingCodes.length} mã bị trùng lặp mang dữ liệu mâu thuẫn:{" "}
              {report.sheet.conflictingCodes.slice(0, 5).join(", ")}
              {report.sheet.conflictingCodes.length > 5 ? "…" : ""}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
