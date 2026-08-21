import { HStack, MetadataList, MetadataListItem, Stack, StatusDot, Text } from "@astryxdesign/core";

import type { TenantHealth } from "@/ui/schemas/tenant-health.schema";

/**
 * Data state of the tenant health screen. Dumb by design: it receives an
 * already-validated object and renders it — no fetching, no branching on
 * business rules (docs/07 §4.1).
 *
 * Not a card of its own any more: it renders INSIDE the panel's card, and a
 * card inside a card is the "card soup" Astryx's layout guidance rules out.
 */

const STATUS_LABELS: Record<TenantHealth["status"], string> = {
  active: "Đang hoạt động",
  suspended: "Tạm ngưng",
};

/**
 * Dot + word, never the dot alone: colour is not information
 * (core-accessibility §5).
 */
const STATUS_DOTS: Record<TenantHealth["status"], "success" | "error"> = {
  active: "success",
  suspended: "error",
};

/**
 * Fixed locale + time zone: the operators are in Vietnam, and reading the
 * browser locale during render would make server and client output differ.
 */
const TIME_FORMATTER = new Intl.DateTimeFormat("vi-VN", {
  dateStyle: "short",
  timeStyle: "medium",
  timeZone: "Asia/Ho_Chi_Minh",
});

function formatCheckedAt(isoString: string): string {
  const parsed = new Date(isoString);
  // Guard: schema-valid ISO can still be an impossible date (e.g. 2026-02-31).
  if (Number.isNaN(parsed.getTime())) return isoString;
  return TIME_FORMATTER.format(parsed);
}

export interface TenantHealthCardProps {
  data: TenantHealth;
  /** True while a background refresh runs — content stays, nothing is covered. */
  isRefreshing?: boolean;
}

export function TenantHealthCard({ data, isRefreshing = false }: TenantHealthCardProps) {
  return (
    <Stack direction="vertical" gap={4} aria-busy={isRefreshing}>
      <HStack gap={3} align="center" justify="between" wrap="wrap">
        <HStack gap={2} align="center" wrap="wrap">
          <StatusDot variant={STATUS_DOTS[data.status]} label={STATUS_LABELS[data.status]} />
          <Text weight="semibold">{data.name}</Text>
          <Text type="supporting">{STATUS_LABELS[data.status]}</Text>
        </HStack>

        {/* Background refresh: a quiet line beside the name, never a spinner
            over the numbers the operator is already reading. */}
        {isRefreshing ? (
          <Text type="supporting" aria-live="polite">
            Đang làm mới…
          </Text>
        ) : null}
      </HStack>

      {/* Label column budgeted in px, as Astryx's layout guidance asks for:
          the three labels have to line up whatever the values do. */}
      <MetadataList label={{ position: "start", width: 144 }}>
        <MetadataListItem label="Mã đơn vị">
          {/* A UUID has no spaces to wrap at; without this it pushes the row. */}
          <Text type="code" className="break-all">
            {data.tenantId}
          </Text>
        </MetadataListItem>

        <MetadataListItem label="Kiểm tra lúc">
          <Text>
            <time dateTime={data.checkedAt}>{formatCheckedAt(data.checkedAt)}</time>
          </Text>
        </MetadataListItem>

        <MetadataListItem label="Chuỗi kiểm tra">
          <Text type="supporting">
            Giao diện → API nội bộ → usecase → cơ sở dữ liệu: thông suốt.
          </Text>
        </MetadataListItem>
      </MetadataList>
    </Stack>
  );
}
