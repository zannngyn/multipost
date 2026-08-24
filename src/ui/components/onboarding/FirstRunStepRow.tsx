import { Card, Stack, StatusDot, Text } from "@astryxdesign/core";
import Link from "next/link";

import { cn } from "@/shared/utils";
import { Badge, type BadgeTone } from "@/ui/components/ui/badge";
import { Button } from "@/ui/components/ui/button";
import { Eyebrow } from "@/ui/components/ui/eyebrow";
import type { StepState, StepView } from "./first-run.types";

/**
 * Tinh chỉnh trạng thái chỉ thị theo 3 màu thuốc nhuộm (DESIGN.md):
 * - done: leaf (lá)
 * - current: chàm (indigo action)
 * - running: turmeric (nghệ)
 * - locked: ink-subtle
 * - error: madder (thiến thảo)
 */
const STATUS_DOT_VARIANTS: Record<
  StepState,
  "success" | "accent" | "warning" | "neutral" | "error"
> = {
  done: "success",
  current: "accent",
  running: "warning",
  locked: "neutral",
  error: "error",
};

const STATUS_TEXT_LABELS: Record<StepState, string> = {
  done: "Đã hoàn thành",
  current: "Cần thực hiện",
  running: "Đang xử lý",
  locked: "Chưa mở khoá",
  error: "Cần xử lý lỗi",
};

const STATUS_BADGE_TONES: Record<StepState, BadgeTone> = {
  done: "success",
  current: "info",
  running: "warning",
  locked: "neutral",
  error: "danger",
};

const STEP_SURFACE_STYLES: Record<StepState, string> = {
  done: "bg-success/5 border-success/30",
  current: "bg-card border-primary/50 shadow-xs ring-1 ring-primary/20",
  running: "bg-warning/5 border-warning/30",
  locked: "bg-muted/20 border-border/50 opacity-80",
  error: "bg-destructive/5 border-destructive/30",
};

export function FirstRunStepRow({ step }: { step: StepView }) {
  const isRunning = step.state === "running";
  const isCurrent = step.state === "current";
  const isDone = step.state === "done";
  const isLocked = step.state === "locked";
  const isError = step.state === "error";

  const dotVariant = STATUS_DOT_VARIANTS[step.state];
  const statusLabel = STATUS_TEXT_LABELS[step.state];
  const badgeTone = STATUS_BADGE_TONES[step.state];
  const surfaceStyle = STEP_SURFACE_STYLES[step.state];

  const ordinalFormatted = `0${step.ordinal}`;

  return (
    <Card
      padding={3}
      className={cn(
        "transition-all duration-200",
        surfaceStyle,
        isCurrent && "translate-x-0.5",
      )}
    >
      <Stack direction="vertical" gap={2}>
        {/* Hàng trên: Nhãn bước + Mã số mono + Trạng thái chữ + Badge tùy chọn */}
        <Stack direction="horizontal" gap={2} align="center" justify="between" wrap="wrap">
          <Stack direction="horizontal" gap={2} align="center">
            {/* Chữ ký số mono sổ mẫu vải */}
            <span
              data-slot="step-ordinal"
              className={cn(
                "font-mono text-xs font-semibold px-2 py-0.5 rounded border tracking-wider",
                isDone && "bg-success/15 border-success/40 text-success-foreground",
                isCurrent && "bg-primary text-primary-foreground border-primary",
                isRunning && "bg-warning/15 border-warning/40 text-warning-foreground",
                isLocked && "bg-muted border-border text-muted-foreground",
                isError && "bg-destructive/15 border-destructive/40 text-destructive",
              )}
            >
              BƯỚC {ordinalFormatted}
            </span>

            {step.isOptional ? (
              <Eyebrow className="text-[10px] text-muted-foreground">Tùy chọn</Eyebrow>
            ) : (
              <Eyebrow className="text-[10px] text-foreground-subtle">Bắt buộc</Eyebrow>
            )}
          </Stack>

          {/* Named Status Rule: StatusDot luôn đi kèm nhãn chữ rõ ràng */}
          <Stack direction="horizontal" gap={1.5} align="center">
            <StatusDot
              variant={dotVariant}
              label={statusLabel}
              isPulsing={isRunning}
            />
            <Badge tone={badgeTone}>
              {statusLabel}
            </Badge>
          </Stack>
        </Stack>

        {/* Thân bước: Tiêu đề + Mô tả + Chi tiết */}
        <Stack direction="vertical" gap={1}>
          <Text weight={isCurrent ? "semibold" : "medium"} className="text-foreground">
            {step.title}
          </Text>

          <Text type="supporting" className="text-xs text-muted-foreground leading-relaxed">
            {step.description}
          </Text>

          {/* Chi tiết phụ: Báo tài khoản đã kết nối, lỗi cụ thể hoặc hướng dẫn */}
          {step.detail ? (
            <p
              className={cn(
                "text-xs mt-1 font-mono rounded px-2.5 py-1 border inline-block max-w-fit",
                isDone && "bg-success/10 border-success/30 text-success-foreground",
                isError && "bg-destructive/10 border-destructive/30 text-destructive",
                isRunning && "bg-warning/10 border-warning/30 text-warning-foreground",
                (isCurrent || isLocked) && "bg-muted/40 border-border text-muted-foreground",
              )}
            >
              {step.detail}
            </p>
          ) : null}
        </Stack>

        {/* Nút hành động và câu giải thích (nếu có) */}
        {step.action ? (
          <Stack direction="vertical" gap={1} className="pt-1">
            <Stack direction="horizontal" gap={2} align="center" wrap="wrap">
              {/*
                An OPEN step is a real link to the screen that owns it: it
                middle-clicks into a new tab and shows its destination on hover,
                like every other navigation in the app. A LOCKED one is a
                disabled button — there is nowhere useful to go yet, and a link
                the operator can follow into a screen that refuses them is worse
                than one they can see is not their turn.
              */}
              {step.action.disabledReason === null ? (
                <Button
                  asChild
                  variant={isCurrent ? "default" : isError ? "destructive" : "secondary"}
                  size="sm"
                >
                  <Link href={step.href}>{step.action.label}</Link>
                </Button>
              ) : (
                <Button type="button" variant="secondary" size="sm" disabled>
                  {step.action.label}
                </Button>
              )}

              {/* The Named Status Rule: Nút mờ BẮT BUỘC có câu giải thích bên cạnh */}
              {step.action.disabledReason ? (
                <Text type="supporting" className="text-xs text-muted-foreground italic">
                  {step.action.disabledReason}
                </Text>
              ) : null}
            </Stack>
          </Stack>
        ) : null}
      </Stack>
    </Card>
  );
}
