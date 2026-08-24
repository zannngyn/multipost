"use client";

import {
  Badge,
  Banner,
  HStack,
  Heading,
  RadioList,
  RadioListItem,
  Selector,
  Stack,
  Text,
} from "@astryxdesign/core";

import {
  candidateFor,
  candidateSummary,
  codesInSheet,
  mediaIssueFor,
  mediaLinkOptions,
  type MediaProfileFormIssue,
  type MediaProfileFormState,
} from "@/ui/components/onboarding/media-profile-form";
import { UNMAPPED_OPTION_VALUE } from "@/ui/components/onboarding/field-map-form";
import {
  DEFAULT_MEDIA_PROFILE_KIND,
  MEDIA_CONFIDENCE_HINTS,
  MEDIA_CONFIDENCE_LABELS,
  MEDIA_PROFILE_KINDS,
  MEDIA_PROFILE_KIND_HINTS,
  MEDIA_PROFILE_KIND_LABELS,
  SHEET_COLUMN_COLOR_LOSS,
  mediaConfidenceBand,
  mediaProfileNeedsLinkColumn,
  type CatalogProfileReport,
  type MediaProfileKind,
} from "@/ui/schemas/catalog-mapping.schema";
/** Same Vietnamese digit grouping every count on the report already uses. */
import { formatCount } from "@/ui/schemas/catalog.schema";

/**
 * The third question of step 3 — "ảnh của bạn nằm ở đâu".
 *
 * It sits in the SAME form as the column map and the stock policy, not in a step
 * of its own, because the answer is partly stored inside the field map: the
 * `sheet-column` layout needs `fieldMap.mediaLink`, so a separate step would
 * either save the map twice or pass a half-map between steps — the exact
 * "mỗi bước một form riêng" that core-wizard names as the source of lost data.
 *
 * Presentational: it fetches nothing and decides nothing. Every number under a
 * layout comes from `report.mediaProfileSuggestion`, where the server ran all
 * four over the same Drive sample. Showing them is the point — an operator is
 * being asked to choose between four things they cannot see, and "vì sao cách
 * này thắng" has to be on screen next to the choice, not in a tooltip.
 */
export function MediaSourceFields({
  report,
  storedKind,
  state,
  issues,
  isDisabled,
  disabledMessage,
  onChange,
}: {
  /** The baseline report: the tenant's columns and the four scored candidates. */
  report: CatalogProfileReport;
  /**
   * The kind this tenant DECLARED, or null when it never declared one and is
   * running on the built-in convention. Same contract as `storedFieldMap`:
   * null pre-fills from the suggestion, a value is restored as-is.
   */
  storedKind: MediaProfileKind | null;
  state: MediaProfileFormState;
  issues: readonly MediaProfileFormIssue[];
  isDisabled: boolean;
  /** Why the controls are disabled (read-only mode), for the tooltip. */
  disabledMessage?: string;
  onChange: (patch: Partial<MediaProfileFormState>) => void;
}) {
  const suggestion = report.mediaProfileSuggestion;
  const columns = report.sheet.columns;
  const codesTotal = codesInSheet(report);
  /** What the pipeline reads TODAY — the default until somebody declares one. */
  const runningKind = storedKind ?? DEFAULT_MEDIA_PROFILE_KIND;
  const band = mediaConfidenceBand(suggestion?.confidence ?? 0);
  const linkIssue = mediaIssueFor(issues, "mediaLinkColumn");
  const kindIssue = mediaIssueFor(issues, "kind");

  return (
    <Stack direction="vertical" gap={3}>
      <Stack direction="vertical" gap={1}>
        <Heading level={3}>Ảnh của bạn nằm ở đâu</Heading>
        <Text type="supporting">
          Hệ thống phải biết ảnh nào thuộc mã nào. Mỗi đơn vị sắp ảnh một kiểu, nên hãy chọn kiểu
          đúng với thư mục Drive của bạn — không cần đổi lại tên file hay sắp xếp lại thư mục.
        </Text>
      </Stack>

      {/*
        Same distinction as the column map, and it matters more here: an
        undeclared tenant is running `code-color-seq` right now, so if the
        recommendation differs, the radio below is showing a CHANGE — that has to
        be said before it is saved, not after.
      */}
      {storedKind === null ? (
        <Banner
          status="info"
          title="Đơn vị này chưa khai nguồn ảnh — đang chạy theo mẫu mặc định"
          description={`Mặc định là “${MEDIA_PROFILE_KIND_LABELS[DEFAULT_MEDIA_PROFILE_KIND]}”. Ô dưới đang chọn sẵn cách hệ thống đề xuất sau khi thử cả bốn cách trên dữ liệu thật của bạn; bấm “Lưu ánh xạ” mới đổi.`}
        />
      ) : (
        <Text type="supporting">
          Đang hiển thị cách đơn vị này đã khai. Đổi ô nào thì chỉ ô đó đổi; bấm “Lưu ánh xạ” mới
          ghi lại.
        </Text>
      )}

      {/*
        Empty state of this section (core-feedback-states): no Drive folder or an
        unreadable one means there is nothing to score. The choice stays open —
        the operator knows their own Drive — and the reason the numbers are
        missing is written down instead of shown as four zeroes.
      */}
      {suggestion === null ? (
        <Banner
          status="warning"
          title="Chưa chấm điểm được bốn cách này"
          description="Báo cáo chưa đọc được thư mục ảnh (chưa khai thư mục Drive, hoặc thư mục chưa được chia sẻ quyền), nên không có số liệu để so sánh. Bạn vẫn chọn được cách đúng với thư mục của mình; số sẽ hiện ở lần chạy báo cáo sau."
        />
      ) : (
        <Text type="supporting">
          Hệ thống đã thử cả bốn cách trên {formatCount(report.media?.sampled ?? 0)} file đã quét
          và đề xuất “{MEDIA_PROFILE_KIND_LABELS[suggestion.recommended]}” — độ tin cậy:{" "}
          {MEDIA_CONFIDENCE_LABELS[band]}. {MEDIA_CONFIDENCE_HINTS[band]}
        </Text>
      )}

      <RadioList
        label="Cách hệ thống tìm ảnh cho một mã"
        description="Số ở mỗi dòng là kết quả thật khi đem cách đó chạy trên thư mục của bạn."
        value={state.kind}
        onChange={(next) => onChange({ kind: next as MediaProfileKind })}
        isDisabled={isDisabled}
        disabledMessage={disabledMessage}
        status={kindIssue ? { type: kindIssue.severity, message: kindIssue.message } : undefined}
        width="100%"
      >
        {MEDIA_PROFILE_KINDS.map((kind) => (
          <RadioListItem
            key={kind}
            value={kind}
            label={MEDIA_PROFILE_KIND_LABELS[kind]}
            // The hint says what the layout MEANS, the summary says what it
            // WOULD DO here. Neither replaces the other: a tenant recognises
            // their own folder from the first and trusts the choice from the
            // second.
            description={`${MEDIA_PROFILE_KIND_HINTS[kind]} ${candidateSummary(
              candidateFor(suggestion, kind),
              codesTotal,
            )}`}
            // Words, not colour (DESIGN.md §The Named Status Rule).
            endContent={
              <HStack gap={1} wrap="wrap">
                {suggestion?.recommended === kind ? (
                  <Badge variant="info" label="Hệ thống đề xuất" />
                ) : null}
                {runningKind === kind ? <Badge variant="neutral" label="Đang chạy" /> : null}
              </HStack>
            }
          />
        ))}
      </RadioList>

      {mediaProfileNeedsLinkColumn(state.kind) ? (
        <Stack direction="vertical" gap={3}>
          {/* The trade-off stated BEFORE the picker — the operator has to know
              what they are giving up while they choose the column that gives it
              up. A warning and not an error: it is a legitimate choice, it just
              must never be an accidental one. */}
          <Banner
            status="warning"
            title="Chọn cách này là MẤT lọc ảnh theo màu"
            description={SHEET_COLUMN_COLOR_LOSS}
          />

          <Selector
            label="Cột chứa link (hoặc ID) ảnh trên Drive"
            isRequired
            description={
              suggestion?.mediaLinkColumn
                ? `Hệ thống thấy cột “${suggestion.mediaLinkColumn}” chứa link Drive. Ô có thể là link tới một file hoặc tới cả thư mục ảnh của mã đó.`
                : "Ô của cột này chứa link Drive của mã: có thể là link một file, hoặc link cả thư mục ảnh của mã đó."
            }
            options={mediaLinkOptions(columns, state.mediaLinkColumn)}
            value={state.mediaLinkColumn ?? UNMAPPED_OPTION_VALUE}
            onChange={(next) =>
              onChange({ mediaLinkColumn: next === UNMAPPED_OPTION_VALUE ? null : next })
            }
            placeholder="Chọn cột trên bảng của bạn…"
            hasSearch={columns.length > 8}
            searchPlaceholder="Tìm tên cột…"
            isDisabled={isDisabled}
            disabledMessage={disabledMessage}
            status={
              linkIssue ? { type: linkIssue.severity, message: linkIssue.message } : undefined
            }
            statusVariant="detached"
            width="100%"
          />
        </Stack>
      ) : linkIssue ? (
        // The column is not being edited any more but it is still stored and
        // still wrong — saying nothing would hide a value the save carries.
        <Banner
          status={linkIssue.severity === "error" ? "error" : "warning"}
          title="Cột link ảnh đang lưu có vấn đề"
          description={linkIssue.message}
        />
      ) : null}
    </Stack>
  );
}
