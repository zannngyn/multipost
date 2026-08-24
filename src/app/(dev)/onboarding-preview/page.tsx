"use client";

import { Heading, Stack, Text } from "@astryxdesign/core";
import { notFound } from "next/navigation";

import { FirstRunChecklist } from "@/ui/components/onboarding/FirstRunChecklist";
import {
  checklistBlockErrorNoRetryProps,
  checklistBlockErrorRetryProps,
  checklistErrorProps,
  checklistInProgressProps,
  checklistLoadingProps,
  checklistReadyProps,
  operatorEditorReadyProps,
  operatorEditorWaitingProps,
  operatorViewerReadyProps,
  operatorViewerWaitingProps,
} from "@/ui/components/onboarding/first-run.fixtures";
import { OperatorWaitingCard } from "@/ui/components/onboarding/OperatorWaitingCard";
import { Eyebrow } from "@/ui/components/ui/eyebrow";

export default function OnboardingPreviewPage() {
  // Chỉ khả dụng trong môi trường development, tự động 404 khi build production
  if (process.env.NODE_ENV === "production") {
    notFound();
  }

  return (
    <div className="min-h-screen bg-background text-foreground p-6 sm:p-10">
      <Stack direction="vertical" gap={6} maxWidth={960} className="mx-auto">
        {/* Header trang xem thử */}
        <Stack direction="vertical" gap={1}>
          <Eyebrow>DEV ONLY — TRANG XEM THỬ THỊ GIÁC</Eyebrow>
          <Heading level={1} className="text-2xl font-bold tracking-tight">
            Luồng First-Run Onboarding — Sổ Mẫu Vải
          </Heading>
          <Text type="supporting" className="text-sm text-muted-foreground">
            Bản trình diễn toàn bộ trạng thái thị giác của luồng thiết lập 5 bước (Checklist cho Owner/Admin và Màn chờ cho Editor/Viewer).
          </Text>
        </Stack>

        {/* SECTION A: CÁC TRẠNG THÁI CHECKLIST (OWNER / ADMIN) */}
        <Stack direction="vertical" gap={5}>
          <Stack direction="vertical" gap={1} className="border-b border-border pb-2">
            <Eyebrow>PHẦN A — CHECKLIST THIẾT LẬP (DÀNH CHO OWNER / ADMIN)</Eyebrow>
            <Heading level={2} className="text-lg font-semibold">
              Các trạng thái của khối FirstRunChecklist
            </Heading>
          </Stack>

          {/* Biến thể 1: Đang thiết lập dở dang */}
          <Stack direction="vertical" gap={2}>
            <Text weight="semibold" className="text-sm text-primary">
              1. Trạng thái đang tiến hành (2/4 bước hoàn thành, bước 3 đang chạy pulsing, bước 4 bị khóa kèm lý do)
            </Text>
            <FirstRunChecklist {...checklistInProgressProps} />
          </Stack>

          {/* Biến thể 2: Có bước bị lỗi */}
          <Stack direction="vertical" gap={2}>
            <Text weight="semibold" className="text-sm text-destructive">
              2. Trạng thái có bước bị lỗi (Bước 3 lỗi Sheet format, bước 4 là bước hành động chàm hiện tại)
            </Text>
            <FirstRunChecklist {...checklistErrorProps} />
          </Stack>

          {/* Biến thể 3: Đã hoàn thành 100% / Sẵn sàng */}
          <Stack direction="vertical" gap={2}>
            <Text weight="semibold" className="text-sm text-success-foreground">
              3. Trạng thái hoàn tất 100% (isReady = true, hiển thị khối CTA soạn bài đầu tiên)
            </Text>
            <FirstRunChecklist {...checklistReadyProps} />
          </Stack>

          {/* Biến thể 4: Đang tải Skeleton */}
          <Stack direction="vertical" gap={2}>
            <Text weight="semibold" className="text-sm text-muted-foreground">
              4. Trạng thái đang tải ban đầu (isLoading = true, Skeleton aria-hidden)
            </Text>
            <FirstRunChecklist {...checklistLoadingProps} />
          </Stack>

          {/* Biến thể 5: Cả khối bị lỗi mạng (Có nút thử lại) */}
          <Stack direction="vertical" gap={2}>
            <Text weight="semibold" className="text-sm text-destructive">
              5. Cả khối bị lỗi mạng / máy chủ (blockError có onRetry)
            </Text>
            <FirstRunChecklist {...checklistBlockErrorRetryProps} />
          </Stack>

          {/* Biến thể 6: Cả khối bị lỗi phiên (Không có nút thử lại) */}
          <Stack direction="vertical" gap={2}>
            <Text weight="semibold" className="text-sm text-destructive">
              6. Cả khối bị lỗi phiên đăng nhập (blockError với onRetry = null)
            </Text>
            <FirstRunChecklist {...checklistBlockErrorNoRetryProps} />
          </Stack>
        </Stack>

        {/* SECTION B: CÁC TRẠNG THÁI MÀN CHỜ (EDITOR / VIEWER) */}
        <Stack direction="vertical" gap={5} className="pt-6">
          <Stack direction="vertical" gap={1} className="border-b border-border pb-2">
            <Eyebrow>PHẦN B — MÀN HÌNH CHỜ THIẾT LẬP (DÀNH CHO EDITOR / VIEWER)</Eyebrow>
            <Heading level={2} className="text-lg font-semibold">
              Các trạng thái của OperatorWaitingCard
            </Heading>
          </Stack>

          {/* Biến thể 7: Editor đang chờ */}
          <Stack direction="vertical" gap={2}>
            <Text weight="semibold" className="text-sm text-warning-foreground">
              7. Vai Biên tập viên (Editor) — Đang chờ Quản trị viên kết nối dữ liệu
            </Text>
            <OperatorWaitingCard {...operatorEditorWaitingProps} />
          </Stack>

          {/* Biến thể 8: Editor đã sẵn sàng */}
          <Stack direction="vertical" gap={2}>
            <Text weight="semibold" className="text-sm text-success-foreground">
              8. Vai Biên tập viên (Editor) — Xưởng đã sẵn sàng (Có nút Bắt đầu soạn bài)
            </Text>
            <OperatorWaitingCard {...operatorEditorReadyProps} />
          </Stack>

          {/* Biến thể 9: Viewer đang chờ */}
          <Stack direction="vertical" gap={2}>
            <Text weight="semibold" className="text-sm text-muted-foreground">
              9. Vai Người xem (Viewer) — Đang chờ thiết lập (Chỉ xem, không có quyền can thiệp)
            </Text>
            <OperatorWaitingCard {...operatorViewerWaitingProps} />
          </Stack>

          {/* Biến thể 10: Viewer đã sẵn sàng */}
          <Stack direction="vertical" gap={2}>
            <Text weight="semibold" className="text-sm text-foreground">
              10. Vai Người xem (Viewer) — Xưởng đã sẵn sàng (TUYỆT ĐỐI KHÔNG HIỆN NÚT SOẠN BÀI)
            </Text>
            <OperatorWaitingCard {...operatorViewerReadyProps} />
          </Stack>
        </Stack>
      </Stack>
    </div>
  );
}
