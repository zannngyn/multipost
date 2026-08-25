import {
  Button,
  Card,
  Heading,
  Skeleton,
  Stack,
  Text,
} from "@astryxdesign/core";

import Link from "next/link";

import { cn } from "@/shared/utils";
import { Eyebrow } from "@/ui/components/ui/eyebrow";
import type { FirstRunChecklistProps } from "./first-run.types";
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
      <Card padding={3} aria-hidden="true" className="border-border bg-card">
        {/* Cùng một dòng, cùng chiều cao với dải thật — skeleton lệch chiều cao
            làm cả trang nhảy một nhịp khi dữ liệu về. */}
        <div className="flex flex-wrap items-center gap-4">
          <span className="flex items-center gap-1">
            {SETUP_STEP_PRESENTATION.map((step) => (
              <Skeleton key={step.id} width={24} height={8} />
            ))}
          </span>
          <span className="min-w-0 flex-1">
            <Skeleton width="60%" height={20} />
          </span>
          <Skeleton width={104} height={32} />
        </div>
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
      {/* Dải thiết lập — MỘT dòng, không phải một danh sách.
          Danh sách đầy đủ sống ở dock góc phải (SetupDock), nên nhắc lại cả
          sáu hàng ở đây chỉ đẩy mọi thứ khác xuống dưới màn hình. Khối này trả
          lời đúng hai câu: còn mấy bước, và bước kế tiếp là bước nào. */}
      <Card padding={3} className="border-border bg-card shadow-xs">
        <div className="flex flex-wrap items-center gap-4">
          {/* Sáu mũi chỉ khâu — trạng thái đọc được bằng mắt, số đọc được bằng
              trình đọc màn hình. Từng mũi ẩn với a11y để không đọc ra sáu ô rỗng. */}
          <span
            role="img"
            aria-label={`Đã xong ${doneCount} trên ${requiredCount} bước bắt buộc`}
            className="flex items-center gap-1"
          >
            {steps.map((step) => (
              <span
                key={step.id}
                aria-hidden="true"
                className={cn(
                  "block h-2 w-6 rounded-full",
                  step.state === "done"
                    ? "bg-primary"
                    : step.state === "current"
                      ? "bg-primary/30 ring-primary/60 ring-1"
                      : "bg-border",
                )}
              />
            ))}
          </span>

          <p className="text-foreground min-w-0 flex-1 text-sm">
            {isReady ? (
              "Thiết lập xong — sẵn sàng soạn bài."
            ) : (
              <>
                <span className="font-medium">
                  Còn {Math.max(0, requiredCount - doneCount)} bước thiết lập
                </span>
                <span className="text-muted-foreground">
                  {" · tiếp theo: "}
                  {steps.find((step) => step.state === "current")?.title ?? "—"}
                </span>
              </>
            )}
          </p>

          {/* Link, không phải nút gọi router: mở được tab mới, hiện đích khi rê
              chuột, và điều hướng phía client như mọi chỗ khác trong app. */}
          <Link
            href={
              isReady ? "/compose" : (steps.find((step) => step.state === "current")?.href ?? "/")
            }
            className="bg-primary text-primary-foreground hover:bg-primary/80 focus-visible:ring-ring inline-flex h-8 shrink-0 items-center rounded-lg px-3 text-[0.8rem] font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none"
          >
            {isReady ? "Soạn bài đầu tiên" : "Mở bước này"}
          </Link>
        </div>
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
