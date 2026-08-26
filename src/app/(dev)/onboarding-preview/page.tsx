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
import { DockPanel, DockPill } from "@/ui/components/onboarding/SetupDock";
import { ProgressRail } from "@/ui/components/onboarding/flow/ProgressRail";
import { WizardStepInvite } from "@/ui/components/onboarding/WizardStepInvite";
import { Eyebrow } from "@/ui/components/ui/eyebrow";
import type { SetupProgress, SetupStepId } from "@/ui/schemas/setup-progress.schema";

const PREVIEW_STEP_IDS: readonly SetupStepId[] = [
  "tenant",
  "google",
  "source",
  "facebook",
  "group",
  "firstPost",
];

/** A payload shaped exactly like the endpoint's, without needing the endpoint. */
function previewProgress(done: Partial<Record<SetupStepId, boolean>>): SetupProgress {
  const required = PREVIEW_STEP_IDS.filter((id) => id !== "firstPost");
  return {
    tenantId: "00000000-0000-0000-0000-000000000001",
    steps: PREVIEW_STEP_IDS.map((id) => ({ id, isDone: done[id] ?? false })),
    doneCount: required.filter((id) => done[id]).length,
    requiredCount: required.length,
    isReady: Boolean(done.source && done.facebook),
  };
}

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

        {/* SECTION C: DOCK GÓC DƯỚI PHẢI + MODAL 2 BƯỚC (M2.4) */}
        <Stack direction="vertical" gap={5} className="pt-6">
          <Stack direction="vertical" gap={1} className="border-b border-border pb-2">
            <Eyebrow>PHẦN C — DOCK THIẾT LẬP VÀ MODAL FIRST-RUN</Eyebrow>
            <Heading level={2} className="text-lg font-semibold">
              Vùng nhắc góc dưới phải và modal 2 bước
            </Heading>
            <Text type="supporting" className="text-sm text-muted-foreground">
              Dock ở đây dựng inline để xem trong mạch trang; trong app thật nó ghim cố định ở góc
              dưới bên phải và tự quyết định có hiện hay không.
            </Text>
          </Stack>

          <Stack direction="vertical" gap={2}>
            <Text weight="semibold" className="text-sm text-primary">
              11. Dock bung — mới tạo công ty (1/5 bước, bước Google Drive là bước hiện tại)
            </Text>
            <DockPanel isInline progress={previewProgress({ tenant: true })} onCollapse={() => {}} />
          </Stack>

          <Stack direction="vertical" gap={2}>
            <Text weight="semibold" className="text-sm text-success-foreground">
              12. Dock bung — gần xong (4/5 bước, chỉ còn tạo nhóm kênh)
            </Text>
            <DockPanel
              isInline
              progress={previewProgress({
                tenant: true,
                google: true,
                source: true,
                facebook: true,
              })}
              onCollapse={() => {}}
            />
          </Stack>

          <Stack direction="vertical" gap={2}>
            <Text weight="semibold" className="text-sm text-muted-foreground">
              13. Dock thu gọn — dạng pill sau khi bấm X
            </Text>
            <DockPill isInline progress={previewProgress({ tenant: true })} onExpand={() => {}} />
          </Stack>

          {/*
            CAVEAT for everything below (spec §10): this gallery renders OUTSIDE
            Astryx's `Theme`, which `OnboardingFlow` mounts in the real app. Text
            on a dark surface can look fine here and be invisible there, so the
            survey still has to be checked at /onboarding itself.
          */}
          <Stack direction="vertical" gap={2}>
            <Text weight="semibold" className="text-sm text-primary">
              14. Khảo sát onboarding — thanh tiến độ ở ba vị trí trong luồng
            </Text>
            <Stack direction="vertical" gap={4}>
              <ProgressRail current="seller" />
              <ProgressRail current="count" />
              <ProgressRail current="channels" />
            </Stack>
          </Stack>

          <Stack direction="vertical" gap={2}>
            <Text weight="semibold" className="text-sm text-primary">
              15. Mời nhân viên — pane dùng lại ở màn mời
            </Text>
            <div className="bg-card border-border rounded-xl border p-6 shadow-lg">
              <WizardStepInvite onDone={() => {}} />
            </div>
          </Stack>
        </Stack>
      </Stack>
    </div>
  );
}
