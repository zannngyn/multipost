import {
  Grid,
  HStack,
  Heading,
  MetadataList,
  MetadataListItem,
  Stack,
  StatusDot,
  Text,
} from "@astryxdesign/core";

import {
  POST_BATCH_STATUS_LABELS,
  POST_BATCH_STATUS_TONES,
  formatDateTime,
  formatDurationMs,
  type BatchStatusResponse,
  type StatusTone,
} from "@/ui/schemas/post-batch.schema";

/**
 * Batch header: what happened, to which product, and how long it took.
 * Presentational only.
 *
 * Not a Card: this is a page region, not a discrete item you could reorder or
 * remove (`astryx component Card`). The counters are plain numbers on the page
 * rather than six bordered tiles — a tile grid makes six equal claims, and only
 * the non-zero ones are news.
 *
 * Business rule 2: the product CODE and colour are identity, not caption
 * material — and stock/price have no field here at all. Rule 6: `partial` is
 * shown as its own outcome, never softened into "xong".
 */

/**
 * [dup-2/3] Same three-line map as `BulkProgressTable`. The DECISION (status ->
 * tone) still lives once, in `post-batch.schema`; only this rendering detail is
 * copied, and the shared pill component that would hold it
 * (`post/PostStatusBadge`) belongs to another screen's scope.
 */
const DOT_VARIANT: Record<StatusTone, "success" | "warning" | "error" | "accent" | "neutral"> = {
  neutral: "neutral",
  info: "accent",
  success: "success",
  warning: "warning",
  danger: "error",
};

/**
 * "Facebook giữ lịch" is its own counter even though it is already inside
 * "Đang chạy": a batch that sits at 0 published for three days is alarming
 * until you can see that Facebook is holding the posts until their hour (E8.6).
 *
 * `alert` marks the counters that mean somebody has to do something. They get a
 * dot ONLY when they are above zero — a red dot next to "0 lỗi" is noise.
 */
const TOTALS_FIELDS = [
  { key: "total", label: "Tổng số kênh", alert: null },
  { key: "published", label: "Đã đăng", alert: null },
  { key: "inProgress", label: "Đang chạy", alert: null },
  { key: "scheduledOnFacebook", label: "Facebook giữ lịch", alert: null },
  { key: "blocked", label: "Bị chặn", alert: "warning" },
  { key: "failed", label: "Lỗi", alert: "error" },
] as const;

export function BatchSummaryCard({ batch }: { batch: BatchStatusResponse }) {
  const statusLabel = POST_BATCH_STATUS_LABELS[batch.status];

  return (
    <Stack as="section" direction="vertical" gap={4} aria-labelledby="batch-summary-heading">
      <Stack direction="vertical" gap={1}>
        <HStack gap={2} align="center" wrap="wrap">
          <Heading level={2} id="batch-summary-heading">
            Tổng kết lô
          </Heading>
          {/* Colour never carries the outcome alone: the dot repeats the word
              beside it as its accessible name. */}
          <StatusDot
            variant={DOT_VARIANT[POST_BATCH_STATUS_TONES[batch.status]]}
            label={statusLabel}
            isPulsing={batch.status === "running"}
          />
          <Text weight="medium">{statusLabel}</Text>
        </HStack>
        <Text>{batch.summaryMessage}</Text>
      </Stack>

      <Grid columns={{ minWidth: 132, max: 6 }} gap={4}>
        {TOTALS_FIELDS.map((field) => {
          const value = batch.totals[field.key];
          const isAlerting = field.alert !== null && value > 0;

          return (
            <Stack key={field.key} direction="vertical" gap={0.5}>
              <HStack gap={1.5} align="center">
                {isAlerting ? (
                  <StatusDot
                    variant={field.alert === "error" ? "error" : "warning"}
                    label={`${field.label}: cần xử lý`}
                  />
                ) : null}
                <Text
                  size="2xl"
                  weight="semibold"
                  hasTabularNumbers
                  // A zero counter is a fact, not a headline: it steps back so
                  // the numbers that actually happened read first.
                  color={value === 0 ? "placeholder" : "primary"}
                >
                  {value}
                </Text>
              </HStack>
              <Text type="supporting">{field.label}</Text>
            </Stack>
          );
        })}
      </Grid>

      <MetadataList columns={2} label={{ position: "start", width: 132 }}>
        <MetadataListItem label="Mã sản phẩm">
          <Text weight="medium">{batch.productCode}</Text>
        </MetadataListItem>
        <MetadataListItem label="Màu">
          <Text>{batch.color.trim().length > 0 ? batch.color : "Tất cả màu"}</Text>
        </MetadataListItem>
        <MetadataListItem label="Bắt đầu">
          <Text hasTabularNumbers>{formatDateTime(batch.startedAt)}</Text>
        </MetadataListItem>
        <MetadataListItem label="Kết thúc">
          <Text hasTabularNumbers>
            {batch.finishedAt ? formatDateTime(batch.finishedAt) : "— (chưa xong)"}
          </Text>
        </MetadataListItem>
        {batch.durationMs !== null ? (
          <MetadataListItem label="Thời gian chạy">
            <Text hasTabularNumbers>{formatDurationMs(batch.durationMs)}</Text>
          </MetadataListItem>
        ) : null}
        <MetadataListItem label="Mã lô">
          {/* The string support asks for: kept whole, kept selectable, and not
              allowed to stretch the column. */}
          <Text type="code" size="2xs" maxLines={1} wordBreak="break-all">
            {batch.batchId}
          </Text>
        </MetadataListItem>
      </MetadataList>
    </Stack>
  );
}
