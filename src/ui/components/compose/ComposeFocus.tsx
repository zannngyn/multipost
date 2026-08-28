"use client";

import { Banner, Button } from "@astryxdesign/core";
import { useRouter } from "next/navigation";
import { useCallback, useId, useMemo, useState } from "react";
import { useWatch } from "react-hook-form";
import {
  Sparkles,
  Check,
  Video as VideoIcon,
  Image as ImageIcon,
  Smartphone,
  FolderSync,
  UploadCloud,
} from "lucide-react";

import { cn } from "@/shared/utils";
import {
  channelLabelIndex,
  channelNameOf,
  channelSentenceName,
} from "@/ui/components/channels/channel-option-labels";
import { StockCheckSkippedBanner } from "@/ui/components/inventory/StockCheckSkippedBanner";
import { stockLabel } from "@/ui/components/inventory/stock-check";
import { activeCaptionChannel } from "@/ui/components/compose/caption-targets";
import { ChannelChoice } from "@/ui/components/compose/ChannelChoice";
import { ChannelPickerDialog } from "@/ui/components/compose/ChannelPickerDialog";
import { publishableChannels } from "@/ui/components/compose/channel-picker";
import { ColorChips } from "@/ui/components/compose/ColorChips";
import { describeAction } from "@/ui/components/compose/compose-action";
import { ComposeActionBar } from "@/ui/components/compose/ComposeActionBar";
import { DraftStatusBar } from "@/ui/components/compose/DraftStatusBar";
import { ManualProductForm } from "@/ui/components/compose/ManualProductForm";
import { ProductPicker } from "@/ui/components/compose/ProductPicker";
import { ResolvedProductLine } from "@/ui/components/compose/ResolvedProductLine";
import { VideoSpecCard } from "@/ui/components/compose/VideoSpecCard";
import { DetectedCodeNotice } from "@/ui/components/compose/DetectedCodeNotice";
import { InlineMediaGrid } from "@/ui/components/compose/InlineMediaGrid";
import { UniversalLivePreview } from "@/ui/components/compose/UniversalLivePreview";
import { CaptionBlock } from "@/ui/components/compose/CaptionBlock";
import { ApiErrorNotice } from "@/ui/components/feedback/ApiErrorNotice";
import { SchedulePicker } from "@/ui/components/scheduled/SchedulePicker";
import { useChannels } from "@/ui/hooks/useChannels";
import { useComposeDraft } from "@/ui/hooks/useComposeDraft";
import { useComposeWizard } from "@/ui/hooks/useComposeWizard";
import { useDelayedFlag } from "@/ui/hooks/useDelayedFlag";
import { usePublishForm } from "@/ui/hooks/usePublishForm";
import { useReadOnlyReason } from "@/ui/hooks/useReadOnlyReason";
import type { Channel } from "@/ui/schemas/channel.schema";
import {
  type MediaKind,
  type VideoTarget,
  type MediaAsset,
} from "@/ui/schemas/compose.schema";
import {
  EMPTY_MANUAL_PRODUCT,
  type ManualProductFormValues,
} from "@/ui/schemas/manual-product.schema";

const POST_KINDS = [
  {
    value: "image",
    label: "Bài Ảnh",
    icon: ImageIcon,
    hint: "Tối đa 10 ảnh",
    mediaKind: "image" as MediaKind,
    videoTarget: "facebook_video" as VideoTarget,
  },
  {
    value: "video",
    label: "Video Feed",
    icon: VideoIcon,
    hint: "Tỷ lệ 16:9 hoặc vuông",
    mediaKind: "video" as MediaKind,
    videoTarget: "facebook_video" as VideoTarget,
  },
  {
    value: "reels",
    label: "Reels / TikTok",
    icon: Smartphone,
    hint: "Video dọc 9:16",
    mediaKind: "video" as MediaKind,
    videoTarget: "facebook_reels" as VideoTarget,
  },
] as const;

function postKindOf(mediaKind: MediaKind, videoTarget: VideoTarget): string {
  if (mediaKind !== "video") return "image";
  return videoTarget === "facebook_reels" ? "reels" : "video";
}

const PREVIEW_CHANNEL = "facebook";
const PREVIEW_PAGE_NAME = "Page Facebook của bạn";

function channelName(channels: readonly Channel[] | undefined, channelId: string): string {
  return channelNameOf(channelId, channels);
}

export function ComposeFocus() {
  const router = useRouter();
  const wizard = useComposeWizard();
  const publish = usePublishForm(wizard);
  const draft = useComposeDraft(wizard, publish);
  const channels = useChannels();

  const fieldId = useId();
  const readOnlyReason = useReadOnlyReason();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [activeChannelId, setActiveChannelId] = useState<string | null>(null);
  const [refusedColors, setRefusedColors] = useState<Record<string, string>>({});
  const [flash, setFlash] = useState<string | null>(null);
  const [isManualOpen, setIsManualOpen] = useState(false);

  const { form, compose, composed } = wizard;
  const errors = form.formState.errors;
  const showSkeleton = useDelayedFlag(compose.isPending);

  const mediaKind = useWatch({ control: form.control, name: "mediaKind" }) ?? "image";
  const videoTarget = useWatch({ control: form.control, name: "videoTarget" }) ?? "facebook_video";
  const source = useWatch({ control: form.control, name: "source" }) ?? "drive";
  const productCode = useWatch({ control: form.control, name: "productCode" }) ?? "";
  const color = useWatch({ control: form.control, name: "color" }) ?? "";

  const codeErrorId = `${fieldId}-code-error`;
  const codeHintId = `${fieldId}-code-hint`;

  const offersManualProduct =
    compose.isError && compose.error?.code === "PRODUCT_NOT_FOUND";
  const isManualComposed = Boolean(composed && composed.productOrigin === "manual");

  const colors = composed?.availableColors ?? [];
  const albumCount = composed?.media.length ?? 0;
  const isVideo = mediaKind === "video";

  const lookUp = useCallback(
    async (targetColor?: string) => {
      const outcome = await wizard.submitProductStep();
      if (!outcome.ok && "error" in outcome && outcome.error && targetColor) {
        setRefusedColors((prev) => ({
          ...prev,
          [targetColor]: outcome.error?.userMessage ?? "Màu này không dùng được",
        }));
      }
    },
    [wizard],
  );

  const handlePostKindChange = (nextValue: string) => {
    const kind = POST_KINDS.find((entry) => entry.value === nextValue);
    if (!kind) return;
    form.setValue("mediaKind", kind.mediaKind, { shouldDirty: true });
    form.setValue("videoTarget", kind.videoTarget, { shouldDirty: true });
    if (productCode && source === "drive") {
      void lookUp(color);
    }
  };

  const handleSourceChange = (nextSource: "drive" | "upload") => {
    form.setValue("source", nextSource, { shouldDirty: true });
    if (nextSource === "drive" && productCode) {
      void lookUp(color);
    }
  };

  const submitManualProduct = async (values: ManualProductFormValues) => {
    wizard.applyManualProduct(productCode, values);
    setIsManualOpen(false);
    await lookUp(color);
  };

  const cancelManualProduct = () => {
    wizard.clearManualProduct();
    setIsManualOpen(false);
  };

  const allChannels = channels.data?.channels ?? [];
  const validChannels = publishableChannels(allChannels);

  const previewChannelId =
    activeCaptionChannel({
      shareCaption: publish.shareCaption,
      selectedIds: publish.selectedIds,
      requested: activeChannelId,
    }) ??
    publish.selectedIds[0] ??
    null;

  const previewCaption = previewChannelId
    ? publish.captionFor(previewChannelId)
    : (wizard.captionValues?.[PREVIEW_CHANNEL] ?? "");
  const previewPage = previewChannelId
    ? channelName(channels.data?.channels, previewChannelId)
    : PREVIEW_PAGE_NAME;
  const previewChannelObj = allChannels.find((c) => c.channelId === previewChannelId);

  const missingCaptionNames = useMemo(() => {
    const index = channelLabelIndex(publish.missingCaptionIds, allChannels);
    return publish.missingCaptionIds.map((id) => channelSentenceName(id, index));
  }, [publish.missingCaptionIds, allChannels]);

  const action = describeAction({
    readOnlyReason,
    hasChannels: validChannels.length > 0,
    hasComposed: Boolean(composed) || wizard.uploadedAssets.length > 0,
    missingCaptionChannels: missingCaptionNames,
    channels: publish.selectedIds.length,
    canSubmit: publish.canSubmit,
  });

  const handleAddFilesToMedia = (files: File[]) => {
    const newItems = files.map((file) => ({
      id: `${file.name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      file,
    }));
    wizard.setUploadQueue([...wizard.uploadQueue, ...newItems]);
    if (source !== "upload") {
      form.setValue("source", "upload", { shouldDirty: true });
    }
  };

  const handleRemoveMedia = (index: number) => {
    const next = [...wizard.album];
    next.splice(index, 1);
    wizard.setAlbum(next);
  };

  const displayMedia: MediaAsset[] = useMemo(() => {
    if (wizard.album.length > 0) return [...wizard.album];
    if (wizard.uploadedAssets.length > 0) {
      return wizard.uploadedAssets.map((asset) => ({
        driveFileId: asset.assetId,
        fileName: asset.fileName,
        color: null,
        sequence: asset.sequence,
        kind: asset.kind,
        warnings: [],
        needsReview: false,
      }));
    }
    return [];
  }, [wizard.album, wizard.uploadedAssets]);

  return (
    <div className="bg-background text-foreground relative h-full min-h-0 overflow-y-auto">
      <div className="@container mx-auto flex w-full max-w-[1600px] flex-col gap-4 p-4 lg:p-6">
        {/* Top Header */}
        <header className="flex flex-wrap items-center justify-between gap-4 border-b border-border pb-4">
          <div className="flex items-center gap-3">
            <div className="flex size-9 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-xs">
              <Sparkles className="size-5" />
            </div>
            <div>
              <h1 className="text-lg font-bold tracking-tight">Studio Soạn Bài Đăng</h1>
              <p className="text-xs text-muted-foreground">
                Tạo bài viết đa kênh, hỗ trợ lấy từ kho dữ liệu hoặc tải ảnh/video tự do.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <DraftStatusBar draft={draft} />
          </div>
        </header>

        {/* 3-COLUMN STUDIO LAYOUT */}
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-12 items-start">
          {/* COLUMN 1: SIDEBAR CẤU HÌNH & CHẾ ĐỘ (Col 1-3) */}
          <aside
            aria-label="Cấu hình chế độ & dữ liệu"
            className="lg:col-span-3 flex flex-col gap-5 rounded-2xl border border-border bg-card p-5 shadow-xs"
          >
            {/* Section 1: Nguồn dữ liệu */}
            <div className="flex flex-col gap-2">
              <label className="text-[11px] font-bold text-muted-foreground uppercase tracking-wider">
                1. Nguồn bài viết
              </label>
              <div className="grid grid-cols-2 gap-1.5 rounded-xl bg-muted p-1">
                <button
                  type="button"
                  onClick={() => handleSourceChange("drive")}
                  className={cn(
                    "flex flex-col items-center justify-center gap-1.5 rounded-lg py-2.5 px-2 text-xs font-semibold transition-all",
                    source === "drive"
                      ? "bg-card text-foreground shadow-xs"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <FolderSync className="size-4 text-sky-500" />
                  <span>Từ kho Drive</span>
                </button>
                <button
                  type="button"
                  onClick={() => handleSourceChange("upload")}
                  className={cn(
                    "flex flex-col items-center justify-center gap-1.5 rounded-lg py-2.5 px-2 text-xs font-semibold transition-all",
                    source === "upload"
                      ? "bg-card text-foreground shadow-xs"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <UploadCloud className="size-4 text-emerald-500" />
                  <span>Tải trực tiếp</span>
                </button>
              </div>
            </div>

            {/* Section 2: Kiểu bài đăng */}
            <div className="flex flex-col gap-2">
              <label className="text-[11px] font-bold text-muted-foreground uppercase tracking-wider">
                2. Định dạng bài
              </label>
              <div className="flex flex-col gap-1.5">
                {POST_KINDS.map((kind) => {
                  const Icon = kind.icon;
                  const active = postKindOf(mediaKind, videoTarget) === kind.value;
                  return (
                    <button
                      key={kind.value}
                      type="button"
                      onClick={() => handlePostKindChange(kind.value)}
                      className={cn(
                        "flex items-center justify-between rounded-xl border p-3 text-left transition-all",
                        active
                          ? "border-primary bg-primary/5 text-foreground shadow-xs ring-1 ring-primary"
                          : "border-border bg-card/50 text-muted-foreground hover:border-border/80 hover:bg-muted/30 hover:text-foreground",
                      )}
                    >
                      <div className="flex items-center gap-2.5">
                        <div
                          className={cn(
                            "flex size-8 items-center justify-center rounded-lg",
                            active ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground",
                          )}
                        >
                          <Icon className="size-4" />
                        </div>
                        <div>
                          <p className="text-xs font-bold">{kind.label}</p>
                          <p className="text-[10px] text-muted-foreground">{kind.hint}</p>
                        </div>
                      </div>
                      {active && <Check className="size-4 text-primary" />}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Section 3: Thông tin mã & tồn kho */}
            <div className="flex flex-col gap-2 border-t border-border pt-4">
              <label className="text-[11px] font-bold text-muted-foreground uppercase tracking-wider">
                3. Thông tin mã sản phẩm
              </label>

              {source === "drive" ? (
                <form
                  noValidate
                  onSubmit={(e) => {
                    e.preventDefault();
                    void lookUp(color);
                  }}
                  className="flex flex-col gap-2.5"
                >
                  <ProductPicker
                    id={`${fieldId}-code`}
                    register={form.register("productCode")}
                    value={productCode}
                    onSelectCode={(code) => {
                      form.setValue("productCode", code, { shouldDirty: true, shouldValidate: true });
                      void lookUp(color);
                    }}
                    onSubmit={() => void lookUp(color)}
                    suppressSuggestions={isManualOpen}
                    disabled={compose.isPending}
                    invalid={Boolean(errors.productCode)}
                    describedBy={errors.productCode ? `${codeErrorId} ${codeHintId}` : codeHintId}
                    placeholder="Nhập mã sản phẩm…"
                    inputClassName="h-10 rounded-lg border border-input bg-card px-3 text-sm font-medium"
                  />

                  {errors.productCode && (
                    <p id={codeErrorId} role="alert" className="text-xs text-destructive">
                      {errors.productCode.message}
                    </p>
                  )}

                  {composed ? (
                    <ResolvedProductLine
                      id={codeHintId}
                      composed={composed}
                      albumCount={albumCount}
                      onChangeProduct={() => {
                        form.setValue("productCode", "", { shouldDirty: true });
                        form.setValue("color", "", { shouldDirty: true });
                        setRefusedColors({});
                        cancelManualProduct();
                        form.setFocus("productCode");
                      }}
                    />
                  ) : (
                    <button
                      type="submit"
                      disabled={compose.isPending}
                      className="flex h-9 items-center justify-center rounded-lg bg-foreground px-4 text-xs font-semibold text-background transition-opacity hover:opacity-90 disabled:opacity-50"
                    >
                      {compose.isPending ? "Đang tra cứu…" : "Tra dữ liệu kho"}
                    </button>
                  )}

                  {compose.isError && !isManualOpen && (
                    <ApiErrorNotice
                      error={compose.error}
                      onRetry={() => void lookUp(color)}
                      extraAction={
                        offersManualProduct ? (
                          <Button
                            variant="secondary"
                            label="Nhập tay thông tin"
                            isDisabled={compose.isPending || Boolean(readOnlyReason)}
                            onClick={() => setIsManualOpen(true)}
                          />
                        ) : undefined
                      }
                    />
                  )}

                  {isManualOpen && (
                    <ManualProductForm
                      productCode={productCode.trim().toUpperCase()}
                      defaultValues={wizard.manualProduct?.values ?? EMPTY_MANUAL_PRODUCT}
                      isEditing={isManualComposed}
                      isPending={compose.isPending}
                      error={compose.error ?? null}
                      readOnlyReason={readOnlyReason}
                      onSubmit={(values) => void submitManualProduct(values)}
                      onCancel={cancelManualProduct}
                    />
                  )}

                  {isManualComposed && !isManualOpen && (
                    <Banner
                      status="info"
                      title="Sản phẩm này do bạn nhập tay"
                      description="Dữ liệu dùng để viết caption không lấy từ bảng dữ liệu đã đồng bộ."
                      endContent={
                        <Button
                          variant="secondary"
                          size="sm"
                          label="Sửa thông tin"
                          isDisabled={compose.isPending || Boolean(readOnlyReason)}
                          onClick={() => setIsManualOpen(true)}
                        />
                      }
                    />
                  )}

                  {composed && stockLabel(composed.inventory).isSkipped && (
                    <StockCheckSkippedBanner
                      reason={composed.inventory?.stockCheckSkippedReason ?? null}
                    />
                  )}

                  {composed && colors.length > 0 && (
                    <div className="pt-2">
                      <ColorChips
                        colors={colors}
                        active={color}
                        albumCount={albumCount}
                        unavailable={refusedColors}
                        pending={compose.isPending}
                        onPick={(next) => {
                          form.setValue("color", next, { shouldDirty: true });
                          void lookUp(next);
                        }}
                        onRefused={setFlash}
                      />
                    </div>
                  )}

                  {composed?.video && (
                    <div className="pt-2">
                      <VideoSpecCard video={composed.video} clip={composed.media[0]} />
                    </div>
                  )}
                </form>
              ) : (
                <div className="flex flex-col gap-3">
                  <div className="flex flex-col gap-1.5">
                    <input
                      id={`${fieldId}-upload-code`}
                      type="text"
                      placeholder="Mã lưu nhật ký (tùy chọn)…"
                      {...form.register("productCode")}
                      className="h-10 w-full rounded-lg border border-input bg-card px-3 text-sm font-medium outline-none focus:border-ring focus:ring-2 focus:ring-ring/30"
                    />
                    <p className="text-[11px] text-muted-foreground">
                      Mã này được ghi vào nhật ký đăng bài để bạn dễ tìm lại bài viết.
                    </p>
                  </div>

                  <DetectedCodeNotice
                    verdict={wizard.detection?.verdict ?? null}
                    warnings={wizard.detection?.warnings ?? []}
                    isPending={wizard.detect.isPending || compose.isPending}
                    onAction={(action) => wizard.applyDetectedCode(action.code)}
                  />

                  {wizard.uploadQueue.length > 0 && (
                    <button
                      type="button"
                      disabled={wizard.upload.isPending}
                      onClick={() => wizard.upload.mutate()}
                      className="flex h-9 items-center justify-center gap-2 rounded-lg bg-emerald-600 px-4 text-xs font-semibold text-white transition-opacity hover:bg-emerald-700 disabled:opacity-50"
                    >
                      <UploadCloud className="size-4" />
                      <span>
                        {wizard.upload.isPending
                          ? `Đang tải ${wizard.uploadProgress}%…`
                          : `Lưu ${wizard.uploadQueue.length} tệp lên hệ thống`}
                      </span>
                    </button>
                  )}
                </div>
              )}

              {/* Internal Warnings: Outside and above the Caption Block */}
              {composed && composed.warnings.length > 0 && (
                <ul aria-label="Cảnh báo nội bộ" className="flex flex-col gap-1.5 pt-2">
                  {composed.warnings.map((warning) => (
                    <li
                      key={warning}
                      className="bg-warning/15 text-warning-foreground rounded-lg px-3 py-2 text-xs leading-relaxed"
                    >
                      {warning}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </aside>

          {/* COLUMN 2: WORKSPACE SOẠN BÀI (Col 4-8) */}
          <main
            aria-label="Khu vực soạn bài viết"
            className="lg:col-span-5 flex flex-col gap-5 rounded-2xl border border-border bg-card p-5 shadow-xs"
          >
            {/* Channel Choice Section */}
            <ChannelChoice publish={publish} onOpenPicker={() => setPickerOpen(true)} />

            {/* Caption Block with multi-channel support */}
            <CaptionBlock
              wizard={wizard}
              publish={publish}
              activeChannelId={activeChannelId}
              onActiveChannelChange={setActiveChannelId}
              onOpenPicker={() => setPickerOpen(true)}
              readOnlyReason={readOnlyReason}
            />

            {/* Inline Media Grid */}
            <div className="rounded-xl border border-border bg-card p-4 shadow-xs">
              <label className="text-xs font-bold uppercase tracking-wider text-muted-foreground block mb-3">
                Ảnh & Video đính kèm
              </label>
              <InlineMediaGrid
                media={displayMedia}
                mediaKind={mediaKind}
                onReorder={wizard.setAlbum}
                onRemove={handleRemoveMedia}
                onAddFiles={handleAddFilesToMedia}
                disabled={compose.isPending}
              />
            </div>

            {/* Sticky Action Tray */}
            <div className="sticky bottom-0 z-10 -mx-5 -mb-5 flex flex-col gap-3.5 rounded-b-2xl border-t border-border bg-card p-5 shadow-sm">
              {publish.formError && (
                <p role="alert" className="text-xs font-semibold text-destructive">
                  {publish.formError}
                </p>
              )}

              {publish.createBatch.isError && (
                <ApiErrorNotice error={publish.createBatch.error} />
              )}

              {publish.schedule.mode === "scheduled" && (
                <SchedulePicker
                  choice={publish.schedule}
                  disabled={publish.isPending || Boolean(readOnlyReason)}
                  disabledReason={readOnlyReason ?? undefined}
                  hideModeChoice
                  scopeNote="Áp dụng cho mọi kênh đã chọn. Bấm “Hẹn lịch” lần nữa để quay lại đăng ngay."
                />
              )}

              <ComposeActionBar
                primaryLabel={publish.submitLabel}
                onPrimary={publish.submit}
                primaryDisabled={!action.enabled}
                busy={publish.isPending}
                scheduling={publish.schedule.mode === "scheduled"}
                onToggleSchedule={() =>
                  publish.schedule.setMode(
                    publish.schedule.mode === "scheduled" ? "now" : "scheduled",
                  )
                }
                onPickChannels={() => setPickerOpen(true)}
                note={action.note}
                readOnlyReason={readOnlyReason}
              />
            </div>
          </main>

          {/* COLUMN 3: LIVE PREVIEW (Col 9-12) */}
          <div className="lg:col-span-4 flex flex-col gap-4 lg:sticky lg:top-5">
            <UniversalLivePreview
              caption={previewCaption}
              channelName={previewPage}
              channelPlatform={previewChannelObj?.platform ?? "facebook"}
              videoTarget={videoTarget}
              media={displayMedia}
              isVideo={isVideo}
            />
          </div>
        </div>
      </div>

      {/* Channel Picker Modal */}
      <ChannelPickerDialog
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        applied={publish.selected}
        onApply={publish.setSelectedChannels}
        readOnlyReason={readOnlyReason}
      />

      {/* Flash Toast */}
      {flash && (
        <div className="pointer-events-none fixed inset-x-0 bottom-6 z-50 flex justify-center px-4">
          <p
            role="status"
            className="pointer-events-auto rounded-xl bg-foreground text-background px-5 py-3 text-xs font-semibold shadow-lg flex items-center gap-3"
          >
            <span>{flash}</span>
            <button
              type="button"
              onClick={() => setFlash(null)}
              className="cursor-pointer underline font-bold"
            >
              Đóng
            </button>
          </p>
        </div>
      )}
    </div>
  );
}
