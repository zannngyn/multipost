import {
  Button,
  Card,
  Divider,
  Heading,
  ProgressBar,
  Skeleton,
  Stack,
  Text,
} from "@astryxdesign/core";

import { Eyebrow } from "@/ui/components/ui/eyebrow";
import type { FirstRunChecklistProps } from "./first-run.types";
import { FirstRunStepRow } from "./FirstRunStepRow";
import { SETUP_STEP_PRESENTATION } from "./setup-steps";

export function FirstRunChecklist({
  steps,
  doneCount,
  requiredCount,
  isReady,
  onCompose,
  blockError,
  isLoading,
}: FirstRunChecklistProps) {
  // --- 1. Loading State (Skeleton) -------------------------------------------
  if (isLoading) {
    return (
      <Card padding={4} aria-hidden="true" className="border-border bg-card">
        <Stack direction="vertical" gap={3}>
          <Stack direction="vertical" gap={1}>
            <Skeleton width={160} height={14} />
            <Skeleton width={280} height={24} />
            <Skeleton width="100%" height={16} />
          </Stack>
          <Skeleton width="100%" height={12} />
          <Divider orientation="horizontal" />
          {/* Six rows, matching the six real ones — a skeleton that is shorter
              than what replaces it makes the page jump when data lands. */}
          <Stack direction="vertical" gap={2}>
            {SETUP_STEP_PRESENTATION.map((step) => (
              <Skeleton key={step.id} width="100%" height={76} />
            ))}
          </Stack>
        </Stack>
      </Card>
    );
  }

  // --- 2. Block Error State (Cả khối lỗi mạng / phiên) -----------------------
  if (blockError) {
    return (
      <Card padding={4} className="border-destructive/30 bg-destructive/5">
        <Stack direction="vertical" gap={3}>
          <Stack direction="vertical" gap={1}>
            <Eyebrow className="text-destructive">Lỗi hệ thống</Eyebrow>
            <Heading level={2} className="text-foreground text-lg font-semibold">
              Chưa tải được tiến trình thiết lập công ty
            </Heading>
            <Text type="supporting" className="text-sm text-muted-foreground">
              {blockError.message}
            </Text>
          </Stack>

          {/* onRetry null = lỗi 4xx/không đáng thử lại (theo hợp đồng) */}
          {blockError.onRetry ? (
            <Stack direction="horizontal" gap={2} align="center">
              <Button
                variant="secondary"
                label="Thử tải lại"
                onClick={blockError.onRetry}
              />
            </Stack>
          ) : (
            <Text type="supporting" className="text-xs text-muted-foreground italic">
              Vui lòng kiểm tra lại đường truyền mạng hoặc đăng nhập lại.
            </Text>
          )}
        </Stack>
      </Card>
    );
  }

  // --- 3. Main Checklist State ----------------------------------------------
  return (
    <Stack direction="vertical" gap={4}>
      {/* Khối thẻ mẫu chính của dải 5 bước */}
      <Card padding={4} className="border-border bg-card shadow-xs">
        <Stack direction="vertical" gap={3}>
          {/* Header thẻ mẫu sổ vải */}
          <Stack direction="vertical" gap={1}>
            <Stack direction="horizontal" gap={2} align="center" justify="between" wrap="wrap">
              <Eyebrow>Dải bước thiết lập — Sổ mẫu vải</Eyebrow>
              <span className="font-mono text-xs text-foreground-subtle">
                {doneCount}/{requiredCount} bước bắt buộc
              </span>
            </Stack>

            <Heading level={2} className="text-foreground text-lg font-semibold tracking-tight">
              Thiết lập công ty để sẵn sàng đăng bài
            </Heading>

            <Text type="supporting" className="text-xs text-muted-foreground">
              Hoàn thành các bước dưới đây để kết nối kho ảnh, bảng thông tin sản phẩm và Fanpage bán hàng.
            </Text>
          </Stack>

          {/* Thanh đo tiến độ 5 bước */}
          <ProgressBar
            label="Tiến độ thiết lập công ty"
            value={doneCount}
            max={requiredCount}
            hasValueLabel
            formatValueLabel={(val, max) => `${val}/${max} bước hoàn thành`}
            variant={isReady ? "success" : "accent"}
          />

          <Divider orientation="horizontal" />

          {/* Dải rail 5 bước */}
          <Stack direction="vertical" gap={2}>
            {steps.map((step) => (
              <FirstRunStepRow key={step.id} step={step} />
            ))}
          </Stack>
        </Stack>
      </Card>

      {/* --- 4. Ready State: Thẻ ký danh khi đủ điều kiện soạn bài ------------- */}
      {isReady ? (
        <Card padding={4} className="border-primary/40 bg-primary/5 shadow-sm ring-1 ring-primary/20">
          <Stack direction="vertical" gap={2}>
            <Stack direction="vertical" gap={1}>
              <Eyebrow className="text-primary font-semibold">HỆ THỐNG ĐÃ SẴN SÀNG</Eyebrow>
              <Heading level={3} className="text-foreground text-base font-semibold">
                Công ty đã đủ điều kiện để soạn bài đăng đầu tiên
              </Heading>
              <Text type="supporting" className="text-xs text-muted-foreground leading-relaxed">
                Kho hàng đã có mã sản phẩm hợp lệ và Fanpage đã sẵn sàng. Bạn có thể mở giao diện soạn bài,
                chọn sản phẩm và để AI hỗ trợ viết caption ngay bây giờ.
              </Text>
            </Stack>

            <Stack direction="horizontal" gap={2} align="center" wrap="wrap">
              <Button
                variant="primary"
                label="Bắt đầu soạn bài ngay →"
                onClick={onCompose}
              />
            </Stack>
          </Stack>
        </Card>
      ) : null}
    </Stack>
  );
}
