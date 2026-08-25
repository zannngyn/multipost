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

import { StockCheckSkippedBanner } from "@/ui/components/inventory/StockCheckSkippedBanner";
import { headlineNumber, profileFunnel } from "@/ui/components/onboarding/profile-funnel";
import {
  CATALOG_FIELD_LABELS,
  formatPercent,
  type CatalogProfileReport,
} from "@/ui/schemas/catalog-mapping.schema";

/**
 * "Báo cáo tương thích" — what the tool can actually do with THIS customer's
 * spreadsheet, read out loud.
 *
 * This is the screen a customer and a salesperson look at together, so it is
 * built around one number ("bao nhiêu mã đăng được ngay") and the chain of
 * losses that explains it. Nothing here is rounded up: a stage that lost rows
 * says how many and why, and a number that could not be computed is left
 * unwritten with its reason instead of shown as 0 (business rule 5).
 *
 * Presentational — it fetches nothing and decides nothing. Every count comes
 * from `profileCatalogSource`, which runs the same parser and the same stock
 * gate the real pipeline runs: a report must never be more optimistic than the
 * thing that actually posts.
 *
 * Rows, not cards (DESIGN.md §Layout: dữ liệu quét là HÀNG): `Item` + `Divider`
 * is the same row shape the rest of the app scans.
 */
export function CompatibilityReport({
  report,
  /** h2 on the wizard step, h3 when embedded as a preview under the map form. */
  headingLevel = 2,
}: {
  report: CatalogProfileReport;
  headingLevel?: 2 | 3;
}) {
  const headline = headlineNumber(report);
  const stages = profileFunnel(report);
  const subHeadingLevel = (headingLevel + 1) as 3 | 4;
  const mapIssues = report.fieldMap.issues;

  return (
    <Stack direction="vertical" gap={4}>
      {/* --- The number ------------------------------------------------- */}
      <Section variant="muted" padding={5}>
        <Stack direction="vertical" gap={2}>
          {/* Eyebrow (DESIGN.md signature): a woven label, not a heading. */}
          <Text type="label" color="secondary">
            ĐĂNG ĐƯỢC NGAY
          </Text>

          {headline.value === null ? (
            <Text type="large">Chưa tính được</Text>
          ) : (
            <HStack gap={2} align="end" wrap="wrap">
              <Text type="display-1" hasTabularNumbers>
                {String(headline.value)}
              </Text>
              <Text type="supporting">
                trên {String(report.sheet.productsParsed)} mã đọc được từ bảng tính
              </Text>
            </HStack>
          )}

          <Text type="supporting">
            {headline.unavailableReason ??
              (headline.stockCheckSkipped
                ? "Số mã có đủ dòng dữ liệu và có ảnh trên Drive. Đơn vị này tắt kiểm tồn nên số tồn KHÔNG được xét — con số này lạc quan hơn thực tế. Bảng dưới nói rõ các mã còn lại rơi ở đâu."
                : "Số mã có đủ dòng dữ liệu, có ảnh trên Drive và qua được kiểm tồn. Bảng dưới nói rõ các mã còn lại rơi ở đâu.")}
          </Text>
        </Stack>
      </Section>

      {/* The number is optimistic by construction when nobody checked stock —
          said here, next to the number, not only on the catalog screen. */}
      {headline.stockCheckSkipped ? <StockCheckSkippedBanner reason={null} /> : null}

      {/* --- Where the rest went ---------------------------------------- */}
      <Stack direction="vertical" gap={2}>
        <Heading level={subHeadingLevel}>Vì sao chỉ ngần này</Heading>
        <Stack direction="vertical">
          {stages.map((stage, index) => (
            <Fragment key={stage.key}>
              {index > 0 ? <Divider /> : null}
              <Item
                align="start"
                density="compact"
                label={stage.label}
                description={stage.loss ?? "Không mất mã nào ở bước này."}
                endContent={
                  <Text type="large" hasTabularNumbers>
                    {String(stage.value)}
                  </Text>
                }
              />
            </Fragment>
          ))}
        </Stack>
      </Stack>

      {/* --- Caveats about the report itself ----------------------------- */}
      {report.warnings.length > 0 ? (
        <Banner
          status="warning"
          title="Báo cáo này có điểm cần lưu ý"
          description="Các con số ở trên vẫn dùng được, nhưng phải đọc kèm những dòng sau."
          defaultIsExpanded
        >
          <Stack direction="vertical" gap={1} padding={3}>
            {report.warnings.map((warning) => (
              <Text key={warning} type="supporting">
                {warning}
              </Text>
            ))}
          </Stack>
        </Banner>
      ) : null}

      {/* --- Problems with the mapping itself ---------------------------- */}
      {mapIssues.length > 0 ? (
        <Stack direction="vertical" gap={2}>
          <Heading level={subHeadingLevel}>Ánh xạ cột đang có vấn đề</Heading>
          {mapIssues.map((issue) => (
            <Banner
              key={`${issue.code}-${issue.column ?? issue.fields.join(",")}`}
              status={issue.severity === "error" ? "error" : "warning"}
              title={issue.fields.map((field) => CATALOG_FIELD_LABELS[field]).join(" · ")}
              description={issue.detail}
            />
          ))}
        </Stack>
      ) : null}

      {/* --- The operator's to-do list ----------------------------------- */}
      <Stack direction="vertical" gap={2}>
        <Heading level={subHeadingLevel}>Việc cần sửa nhiều nhất</Heading>
        {report.topIssues.length === 0 ? (
          <Text type="supporting">
            Không có nhóm lỗi nào nổi bật. Phần mã chưa đăng được (nếu có) nằm ở các bước trong
            bảng trên, không phải do dữ liệu sai chuẩn.
          </Text>
        ) : (
          <Stack direction="vertical">
            {report.topIssues.map((issue, index) => (
              <Fragment key={issue.reason}>
                {index > 0 ? <Divider /> : null}
                <Item
                  align="start"
                  density="compact"
                  label={issue.detail}
                  description={
                    issue.examples.length > 0
                      ? `Ví dụ: ${issue.examples.join(" · ")}${
                          issue.count > issue.examples.length ? " …" : ""
                        }`
                      : undefined
                  }
                  // The COUNT is the real number of occurrences; `examples` is
                  // capped at three, so the two must not be read as one.
                  endContent={<Badge variant="neutral" label={String(issue.count)} />}
                />
              </Fragment>
            ))}
          </Stack>
        )}
      </Stack>

      <Divider />

      {/* --- The raw facts, for whoever asks ----------------------------- */}
      <Stack direction="vertical" gap={2}>
        <Heading level={subHeadingLevel}>Hệ thống đọc được gì</Heading>
        <Text type="supporting">
          Tab “{report.sheetName}” · {String(report.sheet.columns.length)} cột ·{" "}
          {String(report.sheet.totalRows)} dòng.
          {report.media
            ? ` Thư mục ảnh: đọc ${String(report.media.sampled)} file${
                report.media.capped ? " đầu tiên (lấy mẫu)" : ""
              }, lấy được mã từ tên file ${formatPercent(report.media.parseRate)}.`
            : " Chưa đối chiếu được thư mục ảnh."}
        </Text>

        <HStack gap={1} wrap="wrap">
          {report.sheet.columns.map((column) => (
            <Badge key={column} variant="neutral" label={column} />
          ))}
        </HStack>

        {report.fieldMap.priceLikeColumns.length > 0 ? (
          <Text type="supporting">
            Cột trông như cột giá và KHÔNG được đọc: {report.fieldMap.priceLikeColumns.join(", ")}.
            Giá không bao giờ đi vào caption.
          </Text>
        ) : null}

        {report.sheet.conflictingCodes.length > 0 ? (
          <Text type="supporting">
            {String(report.sheet.conflictingCodes.length)} mã có hai dòng mang dữ liệu khác nhau
            nên bị chặn: {report.sheet.conflictingCodes.slice(0, 5).join(", ")}
            {report.sheet.conflictingCodes.length > 5 ? "…" : ""}
          </Text>
        ) : null}
      </Stack>
    </Stack>
  );
}
