"use client";

import { Banner, Button } from "@astryxdesign/core";
import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { useWatch } from "react-hook-form";
import {
  Sparkles,
  Video as VideoIcon,
  Image as ImageIcon,
  Smartphone,
  FolderSync,
  UploadCloud,
  Layers,
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
import { PostizSocialsBar } from "@/ui/components/compose/PostizSocialsBar";
import { UniversalLivePreview } from "@/ui/components/compose/UniversalLivePreview";
import { CaptionBlock } from "@/ui/components/compose/CaptionBlock";
import { PublishConfirmDialog } from "@/ui/components/compose/PublishConfirmDialog";
import { SchedulePickerDialog } from "@/ui/components/compose/SchedulePickerDialog";
import { ApiErrorNotice } from "@/ui/components/feedback/ApiErrorNotice";
import { SchedulePicker } from "@/ui/components/scheduled/SchedulePicker";
import { useChannels } from "@/ui/hooks/useChannels";
import { useComposeDraft } from "@/ui/hooks/useComposeDraft";
import { useComposeWizard } from "@/ui/hooks/useComposeWizard";
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

  const allChannels = useMemo(() => channels.data?.channels ?? [], [channels.data?.channels]);
  const validChannels = useMemo(() => publishableChannels(allChannels), [allChannels]);

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

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [scheduleModalOpen, setScheduleModalOpen] = useState(false);

  const selectedChannelsList = useMemo(() => {
    return publish.selectedIds.map((id) => {
      const found = allChannels.find((c) => c.channelId === id);
      return {
        id,
        name: found?.name ?? id,
        platform: found?.platform ?? "facebook",
      };
    });
  }, [publish.selectedIds, allChannels]);

  const action = describeAction({
    readOnlyReason,
    hasChannels: validChannels.length > 0,
    hasComposed: Boolean(composed) || wizard.uploadedAssets.length > 0,
    missingCaptionChannels: missingCaptionNames,
    channels: publish.selectedIds.length,
    canSubmit: publish.canSubmit,
  });

  // 1. Instant local previews for uploadQueue files (0ms delay)
  const uploadQueueMedia: MediaAsset[] = useMemo(() => {
    return wizard.uploadQueue.map((item, index) => {
      const blobUrl = URL.createObjectURL(item.file);
      const isVid = item.file.type.startsWith("video/");
      return {
        driveFileId: blobUrl,
        fileName: item.file.name,
        color: null,
        sequence: index + 1,
        kind: isVid ? "video" : "image",
        warnings: [],
        needsReview: false,
      };
    });
  }, [wizard.uploadQueue]);

  // Auto-fill productCode when detection returns a matched code
  useEffect(() => {
    if (wizard.detection?.verdict) {
      const v = wizard.detection.verdict;
      if ("productCode" in v && typeof v.productCode === "string" && v.productCode.trim().length > 0) {
        const curCode = form.getValues("productCode");
        if (!curCode || curCode.trim().length === 0) {
          form.setValue("productCode", v.productCode, { shouldDirty: true });
        }
      }
    }
  }, [wizard.detection, form]);

  const handleAddFilesToMedia = (files: File[]) => {
    const newItems = files.map((file) => ({
      id: `${file.name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      file,
    }));
    const nextQueue = [...wizard.uploadQueue, ...newItems];
    wizard.setUploadQueue(nextQueue);
    if (source !== "upload") {
      form.setValue("source", "upload", { shouldDirty: true });
    }
    // Auto-trigger product code detection on uploaded files
    wizard.detect.mutate(nextQueue);
  };

  const handleRemoveMedia = (index: number) => {
    if (source === "upload" && wizard.uploadQueue.length > 0) {
      const nextQueue = [...wizard.uploadQueue];
      nextQueue.splice(index, 1);
      wizard.setUploadQueue(nextQueue);
      if (nextQueue.length > 0) {
        wizard.detect.mutate(nextQueue);
      }
      return;
    }
    const next = [...wizard.album];
    next.splice(index, 1);
    wizard.setAlbum(next);
  };

  const handleReorderMedia = (nextMedia: MediaAsset[]) => {
    if (source === "upload" && wizard.uploadQueue.length > 0) {
      const nextQueue = nextMedia
        .map((m) => wizard.uploadQueue.find((q) => q.file.name === m.fileName))
        .filter((q): q is (typeof wizard.uploadQueue)[number] => Boolean(q));
      if (nextQueue.length === wizard.uploadQueue.length) {
        wizard.setUploadQueue(nextQueue);
        return;
      }
    }
    wizard.setAlbum(nextMedia as any);
  };

  const displayMedia: MediaAsset[] = useMemo(() => {
    if (source === "upload") {
      if (uploadQueueMedia.length > 0) return uploadQueueMedia;
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
    }
    if (wizard.album.length > 0) return [...wizard.album];
    if (uploadQueueMedia.length > 0) return uploadQueueMedia;
    return [];
  }, [source, uploadQueueMedia, wizard.album, wizard.uploadedAssets]);

  return (
    <div className="bg-background text-foreground relative h-full min-h-0 overflow-y-auto">
      <div className="@container mx-auto flex w-full max-w-[1600px] flex-col gap-5 p-4 lg:p-6">
        <header className="flex flex-wrap items-center justify-between gap-4 border-b border-border/80 pb-4">
          <div className="flex items-center gap-3">
            <div className="flex size-10 items-center justify-center rounded-2xl bg-primary text-primary-foreground shadow-md">
              <Sparkles className="size-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-lg font-bold tracking-tight">Tạo bài viết mới</h1>

              </div>
              <p className="text-xs text-muted-foreground">
                Soạn bài đăng đa kênh với trợ lý AI, tự động đồng bộ kho ảnh và lên lịch thông minh.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <DraftStatusBar draft={draft} />
          </div>
        </header>

        {/* 2-COLUMN SPLIT STUDIO LAYOUT */}
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-12 items-start">
          {/* CỘT CHÍNH 1: KHU VỰC THIẾT LẬP & SOẠN BÀI (Col 1-7) */}
          <main
            aria-label="Khu vực thiết lập và soạn bài viết"
            className="lg:col-span-7 flex flex-col gap-5"
          >
            {/* KHỐI 1: CHỌN CHẾ ĐỘ DỮ LIỆU & ĐỊNH DẠNG SẢN PHẨM (PROMINENT AT TOP) */}
            <section
              aria-label="Chế độ dữ liệu và định dạng"
              className="flex flex-col gap-4 rounded-2xl border border-border bg-card p-5 shadow-xs"
            >
              <div className="flex items-center justify-between border-b border-border/70 pb-3">
                <h2 className="text-xs font-bold text-foreground uppercase tracking-wider flex items-center gap-2">
                  <Layers className="size-4 text-primary" />
                  1. Chế độ nhập dữ liệu & Định dạng bài
                </h2>
              </div>

              {/* Nguồn bài viết */}
              <div className="flex flex-col gap-2">
                <label className="text-[11px] font-bold text-muted-foreground uppercase tracking-wider">
                  Nguồn dữ liệu sản phẩm
                </label>
                <div className="grid grid-cols-2 gap-2 rounded-xl bg-muted/80 p-1.5 border border-border/50">
                  <button
                    type="button"
                    onClick={() => handleSourceChange("drive")}
                    className={cn(
                      "flex items-center justify-center gap-2.5 rounded-lg py-2.5 px-3 text-xs font-bold transition-all cursor-pointer",
                      source === "drive"
                        ? "bg-card text-foreground shadow-sm ring-1 ring-border"
                        : "text-muted-foreground hover:text-foreground hover:bg-card/40",
                    )}
                  >
                    <FolderSync className="size-4 text-sky-500" />
                    <span>Từ Kho Drive / Catalog</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => handleSourceChange("upload")}
                    className={cn(
                      "flex items-center justify-center gap-2.5 rounded-lg py-2.5 px-3 text-xs font-bold transition-all cursor-pointer",
                      source === "upload"
                        ? "bg-card text-foreground shadow-sm ring-1 ring-border"
                        : "text-muted-foreground hover:text-foreground hover:bg-card/40",
                    )}
                  >
                    <UploadCloud className="size-4 text-emerald-500" />
                    <span>Tải Ảnh Lên (Tự nhận mã)</span>
                  </button>
                </div>
              </div>

              {/* Kiểu bài đăng */}
              <div className="flex flex-col gap-2">
                <label className="text-[11px] font-bold text-muted-foreground uppercase tracking-wider">
                  Định dạng bài đăng
                </label>
                <div className="grid grid-cols-3 gap-2">
                  {POST_KINDS.map((kind) => {
                    const Icon = kind.icon;
                    const active = postKindOf(mediaKind, videoTarget) === kind.value;
                    return (
                      <button
                        key={kind.value}
                        type="button"
                        onClick={() => handlePostKindChange(kind.value)}
                        className={cn(
                          "flex items-center justify-center gap-2 rounded-xl border p-2.5 text-center transition-all cursor-pointer",
                          active
                            ? "border-primary bg-primary/5 text-primary font-bold shadow-xs ring-1 ring-primary"
                            : "border-border bg-card text-muted-foreground hover:border-border/80 hover:bg-muted/40 hover:text-foreground",
                        )}
                      >
                        <Icon className="size-4" />
                        <span className="text-xs">{kind.label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Thông tin mã & tồn kho tương ứng */}
              <div className="flex flex-col gap-2.5 border-t border-border/70 pt-3">
                {source === "drive" ? (
                  <form
                    noValidate
                    onSubmit={(e) => {
                      e.preventDefault();
                      void lookUp(color);
                    }}
                    className="flex flex-col gap-2.5"
                  >
                    <label className="text-[11px] font-bold text-muted-foreground uppercase tracking-wider">
                      Mã sản phẩm từ Catalog
                    </label>

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
                      placeholder="Nhập hoặc chọn mã sản phẩm (VD: AT01, DM02)…"
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
                        className="flex h-9 items-center justify-center rounded-lg bg-primary px-4 text-xs font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50 cursor-pointer shadow-xs"
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
                    <label className="text-[11px] font-bold text-muted-foreground uppercase tracking-wider">
                      Tải tệp & Tự nhận diện mã
                    </label>

                    <div className="flex flex-col gap-1.5">
                      <input
                        id={`${fieldId}-upload-code`}
                        type="text"
                        placeholder="Mã lưu nhật ký (tùy chọn)…"
                        {...form.register("productCode")}
                        className="h-10 w-full rounded-lg border border-input bg-card px-3 text-sm font-medium outline-none focus:border-ring focus:ring-2 focus:ring-ring/30"
                      />
                      <p className="text-[11px] text-muted-foreground">
                        Hệ thống sẽ tự động quét mã sản phẩm từ tên file ảnh bạn tải lên.
                      </p>
                    </div>

                    <DetectedCodeNotice
                      verdict={wizard.detection?.verdict ?? null}
                      warnings={wizard.detection?.warnings ?? []}
                      isPending={wizard.detect.isPending || compose.isPending}
                      onAction={(action) => wizard.applyDetectedCode(action.code)}
                    />
                  </div>
                )}
              </div>
            </section>

            {/* KHỐI 2: CHỌN KÊNH & SOẠN THẢO BÀI VIẾT */}
            <section
              aria-label="Khu vực soạn bài viết"
              className="flex flex-col gap-5 rounded-2xl border border-border bg-card p-5 shadow-xs"
            >
              {/* Postiz Social Bar */}
              <PostizSocialsBar
                channels={validChannels}
                publish={publish}
                activeChannelId={activeChannelId}
                onSelectActiveChannel={setActiveChannelId}
                onOpenPicker={() => setPickerOpen(true)}
              />

              {/* Internal Warnings: Above and outside the Caption Block */}
              {composed && composed.warnings.length > 0 && (
                <ul aria-label="Cảnh báo nội bộ" className="flex flex-col gap-1.5 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3">
                  {composed.warnings.map((warning) => (
                    <li
                      key={warning}
                      className="text-amber-900 dark:text-amber-200 text-xs leading-relaxed"
                    >
                      {warning}
                    </li>
                  ))}
                </ul>
              )}

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
              <div className="rounded-xl border border-border/80 bg-card p-4 shadow-xs">
                <div className="flex items-center justify-between mb-3">
                  <label className="text-xs font-bold uppercase tracking-wider text-muted-foreground block">
                    Ảnh & Video đính kèm ({displayMedia.length} tệp)
                  </label>
                  <span className="text-[11px] text-muted-foreground">
                    Kéo thả để đổi thứ tự ảnh
                  </span>
                </div>
                <InlineMediaGrid
                  media={displayMedia}
                  mediaKind={mediaKind}
                  onReorder={handleReorderMedia}
                  onRemove={handleRemoveMedia}
                  onAddFiles={handleAddFilesToMedia}
                  disabled={compose.isPending}
                />
              </div>

              {/* Sticky Action Tray - Postiz Style Action Buttons */}
              <div className="sticky bottom-0 z-10 -mx-5 -mb-5 flex flex-col gap-3.5 rounded-b-2xl border-t border-border bg-card/95 p-5 shadow-sm backdrop-blur-xs">
                {publish.formError && (
                  <p role="alert" className="text-xs font-semibold text-destructive">
                    {publish.formError}
                  </p>
                )}

                {publish.createBatch.isError && (
                  <ApiErrorNotice error={publish.createBatch.error} />
                )}

                <ComposeActionBar
                  onPublishNow={() => {
                    if (!action.enabled || publish.isPending) return;
                    publish.schedule.setMode("now");
                    setConfirmOpen(true);
                  }}
                  onSchedule={() => {
                    if (!action.enabled || publish.isPending) return;
                    publish.schedule.setMode("scheduled");
                    setScheduleModalOpen(true);
                  }}
                  primaryDisabled={!action.enabled}
                  busy={publish.isPending}
                  note={action.note}
                  readOnlyReason={readOnlyReason}
                />
              </div>
            </section>
          </main>

          {/* CỘT PHỤ 2: UNIVERSAL LIVE PREVIEW ĐA NỀN TẢNG (Col 8-12) */}
          <aside
            aria-label="Xem trước bài đăng đa nền tảng"
            className="lg:col-span-5 flex flex-col gap-5 lg:sticky lg:top-5"
          >
            <UniversalLivePreview
              caption={previewCaption}
              channelName={previewPage}
              channelPlatform={previewChannelObj?.platform ?? "facebook"}
              videoTarget={videoTarget}
              media={displayMedia}
              isVideo={isVideo}
            />
          </aside>
        </div>
      </div>

      {/* Modal Hẹn lịch đăng bài (Chọn ngày & giờ) */}
      <SchedulePickerDialog
        open={scheduleModalOpen}
        onOpenChange={setScheduleModalOpen}
        choice={publish.schedule}
        onConfirmSchedule={() => {
          setConfirmOpen(true);
        }}
        disabled={publish.isPending || Boolean(readOnlyReason)}
        disabledReason={readOnlyReason ?? undefined}
      />

      {/* Modal Xác nhận Đăng bài / Lên lịch (Không thể hoàn tác) */}
      <PublishConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        onConfirm={() => {
          setConfirmOpen(false);
          publish.submit();
        }}
        isPending={publish.isPending}
        isScheduled={publish.schedule.mode === "scheduled"}
        scheduledAt={publish.schedule.value}
        channels={selectedChannelsList}
        mediaCount={displayMedia.length}
        isVideo={isVideo}
        productCode={productCode}
        captionPreview={previewCaption}
      />

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
