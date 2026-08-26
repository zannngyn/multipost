"use client";

import { Heading, Stack, Text, Theme } from "@astryxdesign/core";
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
import { ChannelTileGroup } from "@/ui/components/onboarding/flow/ChannelTile";
import { CheckOptionCardGroup } from "@/ui/components/onboarding/flow/CheckOptionCard";
import { OptionCardGroup } from "@/ui/components/onboarding/flow/OptionCard";
import { StepActions } from "@/ui/components/onboarding/flow/StepActions";
import { StepDots } from "@/ui/components/onboarding/flow/StepDots";
import { WizardStepInvite } from "@/ui/components/onboarding/WizardStepInvite";
import { Eyebrow } from "@/ui/components/ui/eyebrow";
import type { SetupProgress, SetupStepId } from "@/ui/schemas/setup-progress.schema";
import { myspTheme } from "@/ui/theme/mysp";

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
              14. Khảo sát onboarding — chấm tiến độ ở ba vị trí trong luồng
            </Text>
            <Stack direction="vertical" gap={4}>
              <StepDots current="seller" />
              <StepDots current="count" />
              <StepDots current="channels" />
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

          <Stack direction="vertical" gap={2}>
            <Text weight="semibold" className="text-sm text-primary">
              16. Khảo sát onboarding — bốn dạng thẻ lựa chọn, cả hai trạng thái
            </Text>
            {/* Inside `Theme`, unlike the rest of this gallery: the cards read
                their border, their tick and their emoji wash off the MYSP
                palette, and outside the scope they would fall back to Astryx's
                own. The four steps themselves are still checked at /onboarding. */}
            <Theme theme={myspTheme}>
              <div className="bg-background flex flex-col gap-6 rounded-xl p-6">
                <SurveyCardGallery />
              </div>
            </Theme>
          </Stack>
        </Stack>
      </Stack>
    </div>
  );
}

/**
 * The four card variants, each drawn twice — once with nothing chosen and once
 * with a choice made. Both halves matter: the whole point of the tick is that
 * the two states differ by more than a border colour, and a gallery that only
 * shows one of them cannot show that.
 *
 * Wording is the spec's (section 6) so the preview measures like the real step
 * will; tasks 7 and 8 own the final copy.
 */
function SurveyCardGallery() {
  const noop = () => {};

  return (
    <Stack direction="vertical" gap={5}>
      <Stack direction="vertical" gap={2} data-preview="option-card-a">
        <Text weight="semibold" className="text-foreground text-sm">
          Dạng A — 341x58, một lựa chọn, có emoji
        </Text>
        <OptionCardGroup
          name="preview-seller-empty"
          legend="Bạn đang bán hàng kiểu nào?"
          choices={SELLER_PREVIEW}
          value={null}
          onChange={noop}
        />
        <OptionCardGroup
          name="preview-seller-chosen"
          legend="Bạn đang bán hàng kiểu nào?"
          choices={SELLER_PREVIEW}
          value="solo_seller"
          onChange={noop}
        />
      </Stack>

      <Stack direction="vertical" gap={2} data-preview="option-card-b">
        <Text weight="semibold" className="text-foreground text-sm">
          Dạng B — 375x58, nhiều lựa chọn, ô tick bên phải
        </Text>
        <CheckOptionCardGroup
          name="preview-tools-empty"
          legend="Bạn đang đăng bài bằng gì?"
          choices={TOOLS_PREVIEW}
          values={[]}
          onToggle={noop}
        />
        <CheckOptionCardGroup
          name="preview-tools-chosen"
          legend="Bạn đang đăng bài bằng gì?"
          choices={TOOLS_PREVIEW}
          values={["manual_facebook", "ai_platform"]}
          onToggle={noop}
        />
      </Stack>

      <Stack direction="vertical" gap={2} data-preview="option-card-c">
        <Text weight="semibold" className="text-foreground text-sm">
          Dạng C — 341x47, chữ trơn
        </Text>
        <OptionCardGroup
          name="preview-count-empty"
          legend="Bạn đang quản lý bao nhiêu trang?"
          choices={COUNT_PREVIEW}
          value={null}
          onChange={noop}
        />
        <OptionCardGroup
          name="preview-count-chosen"
          legend="Bạn đang quản lý bao nhiêu trang?"
          choices={COUNT_PREVIEW}
          value="1_3"
          onChange={noop}
        />
      </Stack>

      <Stack direction="vertical" gap={2} data-preview="option-card-d">
        <Text weight="semibold" className="text-foreground text-sm">
          Dạng D — 156x148, ô kênh, ô tick hiện thường trực
        </Text>
        <ChannelTileGroup
          name="preview-channels-empty"
          legend="Kênh nào bạn đang tập trung?"
          choices={CHANNELS_PREVIEW}
          values={[]}
          onToggle={noop}
        />
        <ChannelTileGroup
          name="preview-channels-chosen"
          legend="Kênh nào bạn đang tập trung?"
          choices={CHANNELS_PREVIEW}
          values={["facebook", "tiktok"]}
          onToggle={noop}
        />
      </Stack>

      <Stack direction="vertical" gap={2} data-preview="step-actions">
        <Text weight="semibold" className="text-foreground text-sm">
          StepActions — chưa chọn / đã chọn / đang lưu
        </Text>
        <StepActions canContinue={false} onContinue={noop} onSkip={noop} />
        <StepActions canContinue onContinue={noop} onSkip={noop} />
        <StepActions canContinue isSaving onContinue={noop} onSkip={noop} />
      </Stack>
    </Stack>
  );
}

const SELLER_PREVIEW = [
  { value: "solo_seller", label: "Bán lẻ cá nhân", emoji: "👋", tone: "indigo" as const },
  { value: "shop_owner", label: "Chủ shop nhỏ", emoji: "💪", tone: "leaf" as const },
  { value: "marketing_team", label: "Trong đội marketing", emoji: "🧑‍💻", tone: "sky" as const },
  { value: "freelancer", label: "Cộng tác viên/freelancer", emoji: "⭐", tone: "turmeric" as const },
  { value: "agency", label: "Agency", emoji: "🏆", tone: "madder" as const },
  { value: "other", label: "Khác", emoji: "🦄", tone: "neutral" as const },
];

const TOOLS_PREVIEW = [
  { value: "manual_facebook", label: "Tự đăng tay trên Facebook", emoji: "💻" },
  { value: "meta_business_suite", label: "Meta Business Suite", emoji: "🔵" },
  {
    value: "social_suite",
    label: "Công cụ quản lý mạng xã hội",
    hint: "vd: Hootsuite, Later",
    emoji: "🛠️",
  },
  { value: "single_platform_tool", label: "Công cụ chuyên một nền tảng", emoji: "🧁" },
  { value: "ai_platform", label: "Nền tảng AI", hint: "ChatGPT/Claude…", emoji: "🤖" },
  { value: "other", label: "Khác", emoji: "🦄" },
];

const COUNT_PREVIEW = [
  { value: "1_3", label: "1-3" },
  { value: "4_6", label: "4-6" },
  { value: "7_10", label: "7-10" },
  { value: "11_20", label: "11-20" },
  { value: "21_50", label: "21-50" },
  { value: "50_plus", label: "50+" },
];

const CHANNELS_PREVIEW = [
  { value: "facebook" as const },
  { value: "tiktok" as const, isComingSoon: true },
  { value: "instagram" as const, isComingSoon: true },
  { value: "youtube" as const, isComingSoon: true },
  { value: "threads" as const, isComingSoon: true },
  { value: "zalo_oa" as const, isComingSoon: true },
  { value: "shopee" as const, isComingSoon: true },
  { value: "lazada" as const, isComingSoon: true },
];
