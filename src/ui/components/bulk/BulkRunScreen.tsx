"use client";

import {
  Collapsible,
  Heading,
  Layout,
  LayoutContent,
  LayoutHeader,
  Text,
} from "@astryxdesign/core";
import { zodResolver } from "@hookform/resolvers/zod";
import Link from "next/link";
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { useForm, useWatch } from "react-hook-form";

import {
  CAPTION_TONES,
  CAPTION_TONE_LABELS,
  DEFAULT_CAPTION_TONE,
} from "@/shared/caption-tone";
import {
  MAX_SPACING_MS,
  MS_PER_MINUTE,
  RECOMMENDED_MIN_SPACING_MS,
  spacingMinutesToMs,
} from "@/shared/publish-spacing";
import { cn } from "@/shared/utils";
import { BulkCodesField } from "@/ui/components/bulk/BulkCodesField";
import { BulkProgressTable } from "@/ui/components/bulk/BulkProgressTable";
import { channelLabelIndex, pruneSelection } from "@/ui/components/channels/channel-option-labels";
import { avatarToneStyle, channelInitials } from "@/ui/components/compose/channel-picker";
import { ChannelPickerDialog } from "@/ui/components/compose/ChannelPickerDialog";
import { EmptyState } from "@/ui/components/feedback/EmptyState";
import { ReadOnlyNotice } from "@/ui/components/feedback/ReadOnlyNotice";
import { SchedulePicker } from "@/ui/components/scheduled/SchedulePicker";
import { Badge } from "@/ui/components/ui/badge";
import { Button } from "@/ui/components/ui/button";
import { Eyebrow } from "@/ui/components/ui/eyebrow";
import { Input } from "@/ui/components/ui/input";
import { Progress } from "@/ui/components/ui/progress";
import { Select } from "@/ui/components/ui/select";
import { Textarea } from "@/ui/components/ui/textarea";
import { useBulkRun } from "@/ui/hooks/useBulkRun";
import { useChannelGroups } from "@/ui/hooks/useChannelGroups";
import { useChannels } from "@/ui/hooks/useChannels";
import { useScheduleChoice } from "@/ui/hooks/useScheduleChoice";
import { writeGate } from "@/ui/hooks/read-only-gate";
import { useReadOnlyReason } from "@/ui/hooks/useReadOnlyReason";
import {
  BULK_CAPTION_MODES,
  BULK_CAPTION_MODE_LABELS,
  BulkRunFormSchema,
  CAPTION_TEMPLATE_VARIABLES,
  findUnknownTemplateVariables,
  parseBulkCodes,
  renderCaptionTemplate,
  type BulkRunFormValues,
} from "@/ui/schemas/bulk.schema";

/**
 * "Chạy hàng loạt" (E10.5): component -> hook -> service -> internal API.
 */

/** Why the run trigger is off before a single code has been typed. */
const EMPTY_CODES_REASON =
  "Chưa có mã nào để chạy — nhập ít nhất một mã sản phẩm vào ô phía trên.";

/**
 * The one sentence about what closing the tab costs, said where the decision is
 * made — beside the trigger, not in an intro paragraph nobody rereads.
 */
const TAB_BOUNDARY_NOTICE =
  "Đóng tab: các lô ĐÃ tạo vẫn đăng tiếp trên máy chủ; các mã CHƯA tạo lô sẽ dừng.";

export function BulkRunScreen() {
  const codesId = useId();
  const templateId = useId();
  const captionModeId = useId();
  const captionToneId = useId();
  const spacingId = useId();
  const detailsId = useId();

  const groups = useChannelGroups();
  const channels = useChannels();
  const run = useBulkRun();
  const schedule = useScheduleChoice();
  const summaryRef = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set<string>());
  const [channelError, setChannelError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  // "Chi tiết" sống ở header nhưng mở khối ở dưới, nên state phải nằm ở đây.
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [ranScheduled, setRanScheduled] = useState(false);
  const [previewCodeIndex, setPreviewCodeIndex] = useState(0);
  const [tableFilter, setTableFilter] = useState<"all" | "done" | "issues">("all");

  const form = useForm<BulkRunFormValues>({
    resolver: zodResolver(BulkRunFormSchema),
    mode: "onSubmit",
    reValidateMode: "onChange",
    defaultValues: {
      codesText: "",
      captionMode: "ai",
      captionTone: DEFAULT_CAPTION_TONE,
      spacingMinutes: "",
      captionTemplate: "",
    },
  });

  const codesText = useWatch({ control: form.control, name: "codesText" }) ?? "";
  const captionMode = useWatch({ control: form.control, name: "captionMode" }) ?? "ai";
  const captionTone =
    useWatch({ control: form.control, name: "captionTone" }) ?? DEFAULT_CAPTION_TONE;
  const spacingMinutes = useWatch({ control: form.control, name: "spacingMinutes" }) ?? "";
  const captionTemplate = useWatch({ control: form.control, name: "captionTemplate" }) ?? "";

  const parsed = useMemo(() => parseBulkCodes(codesText), [codesText]);
  const unknownVariables = useMemo(
    () => findUnknownTemplateVariables(captionTemplate),
    [captionTemplate],
  );

  const prune = useMemo(
    () => pruneSelection(selected, channels.data?.channels),
    [selected, channels.data],
  );
  const runnableSelection = useMemo(
    () => (prune.changed ? new Set(prune.next) : selected),
    [prune, selected],
  );

  const selectedIds = useMemo(() => [...runnableSelection], [runnableSelection]);
  const groupItems = groups.data?.groups ?? [];
  const { phase, summary, rows, isRunning, toneDropped } = run;

  const shownChannels = selectedIds.slice(0, 5);
  const channelLabels = channelLabelIndex(shownChannels, channels.data?.channels);

  const gate = writeGate(useReadOnlyReason(), isRunning);

  /** Có nhập, là số hợp lệ, lớn hơn 0 và nhỏ hơn mức khuyên dùng. */
  const isBelowRecommendedSpacing = (() => {
    const raw = spacingMinutes.trim();
    if (raw.length === 0) return false;
    const minutes = Number(raw);
    if (!Number.isFinite(minutes) || minutes <= 0) return false;
    return minutes * MS_PER_MINUTE < RECOMMENDED_MIN_SPACING_MS;
  })();

  const hasNoCodes = parsed.codes.length === 0;
  const runBlockedReason = gate.reason ?? (hasNoCodes ? EMPTY_CODES_REASON : null);


  useEffect(() => {
    if (phase === "finished") summaryRef.current?.focus();
  }, [phase]);

  function toggleGroup(channelIds: readonly string[], checked: boolean) {
    setChannelError(null);
    setSelected((current) => {
      const next = new Set(current);
      for (const channelId of channelIds) {
        if (checked) next.add(channelId);
        else next.delete(channelId);
      }
      return next;
    });
  }

  function handleInsertVariable(varName: string) {
    const current = form.getValues("captionTemplate") || "";
    form.setValue("captionTemplate", `${current}{${varName}}`, {
      shouldValidate: true,
      shouldDirty: true,
    });
  }

  function handleSubmit(values: BulkRunFormValues) {
    if (selectedIds.length === 0) {
      setChannelError("Chọn ít nhất một kênh để đăng.");
      return;
    }
    setChannelError(null);

    const resolved = schedule.resolve();
    if (!resolved.ok) return;
    setRanScheduled(resolved.scheduledAt !== null);

    void run.start({
      codes: parseBulkCodes(values.codesText).codes.map((item) => item.code),
      channelIds: selectedIds,
      captionMode: values.captionMode,
      captionTone: values.captionTone,
      // Rỗng = để máy chủ dùng cấu hình công ty. `0` là lựa chọn thật, nên
      // kiểm bằng độ dài chuỗi chứ không bằng tính chân trị của con số.
      spacingMs:
        values.spacingMinutes.trim().length > 0
          ? spacingMinutesToMs(Number(values.spacingMinutes.trim()))
          : null,
      captionTemplate: values.captionTemplate,
      scheduledAt: resolved.scheduledAt,
    });
  }

  const totalCodesCount = parsed.codes.length;
  const totalChannelsCount = selectedIds.length;
  const estimatedTotalPosts = totalCodesCount * totalChannelsCount;
  const estimatedDurationMinutes = Math.max(1, Math.ceil((estimatedTotalPosts * 4) / 60));
  const progressPercent =
    summary.total > 0 ? Math.min(100, Math.round((summary.processed / summary.total) * 100)) : 0;

  const currentPreviewCode =
    parsed.codes.length > 0
      ? parsed.codes[Math.min(previewCodeIndex, parsed.codes.length - 1)].code
      : "";

  const filteredRows = useMemo(() => {
    if (tableFilter === "done") return rows.filter((r) => r.status === "done");
    if (tableFilter === "issues")
      return rows.filter(
        (r) => r.status === "skipped" || r.status === "error" || r.status === "cancelled",
      );
    return rows;
  }, [rows, tableFilter]);

  return (
    <>
      <Layout
        height="fill"
        header={
          <LayoutHeader hasDivider padding={0}>
            <div className="mx-auto flex w-full max-w-5xl flex-wrap items-start justify-between gap-4 px-6 py-8 xl:max-w-7xl">
              <div className="max-w-prose space-y-1.5">

                <Heading level={1}>Chạy hàng loạt</Heading>
              </div>

              <div className="flex shrink-0 items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  aria-expanded={detailsOpen}
                  aria-controls={detailsId}
                  onClick={() => setDetailsOpen((open) => !open)}
                >
                  Chi tiết
                </Button>
              </div>
            </div>
          </LayoutHeader>
        }
        content={
          <LayoutContent padding={0} isScrollable>
            <div className="relative mx-auto w-full max-w-5xl xl:max-w-7xl space-y-6 px-6 py-8">
              <ScopeDisclosure id={detailsId} isOpen={detailsOpen} onOpenChange={setDetailsOpen} />

              {/* Main responsive 2-column layout */}
              <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-12 xl:gap-8">
                {/* Cột trái: các thẻ mẫu của form, mỗi thẻ tự mang ô rail của nó */}
                <div className="lg:col-span-7">
                  <form
                    noValidate
                    className="space-y-6"
                    onSubmit={form.handleSubmit(handleSubmit)}
                  >
                    {/* Step 1: Mã sản phẩm */}
                    <StepCard
                      step="1"
                      title="Mã sản phẩm"
                      description="Nhập danh sách mã hoặc dán trực tiếp một cột từ Google Sheets"
                      railLabel="Mã SP"
                      railDetail={totalCodesCount > 0 ? `${totalCodesCount} mã` : "Chưa nhập"}
                      isDone={totalCodesCount > 0}
                      badge={
                        totalCodesCount > 0 ? (
                          <Badge tone="info" className="font-mono">
                            {totalCodesCount} mã
                          </Badge>
                        ) : undefined
                      }
                    >
                      <BulkCodesField
                        id={codesId}
                        registration={form.register("codesText")}
                        parsed={parsed}
                        error={form.formState.errors.codesText?.message}
                        disabled={isRunning}
                      />
                    </StepCard>

                    {/* Step 2: Kênh đăng (Compose-Style Channel Selector) */}
                    <StepCard
                      step="2"
                      title="Kênh đăng"
                      description="Chọn các Fanpage đích để xuất bản bài viết"
                      railLabel="Kênh"
                      railDetail={
                        totalChannelsCount > 0 ? `${totalChannelsCount} kênh` : "Chưa chọn"
                      }
                      isDone={totalChannelsCount > 0}
                      badge={
                        totalChannelsCount > 0 ? (
                          <Badge tone="info" className="font-mono">
                            {totalChannelsCount} kênh
                          </Badge>
                        ) : undefined
                      }
                    >
                      <div className="space-y-3">
                        {/* Cùng lối chọn kênh với màn Soạn bài: một dòng tóm tắt mở ra
                              hộp thoại chọn — hai màn không được có hai cách chọn kênh. */}
                        <button
                          type="button"
                          onClick={() => setPickerOpen(true)}
                          disabled={isRunning}
                          className="focus-visible:ring-ring border-border bg-card hover:bg-muted/30 group flex w-full cursor-pointer items-center gap-3 rounded-xl border p-3.5 text-left shadow-xs transition-all outline-none focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          <span className="text-foreground-subtle bg-muted shrink-0 rounded px-2 py-1 font-mono text-[10px] font-bold tracking-[0.1em]">
                            FACEBOOK
                          </span>

                          {selectedIds.length === 0 ? (
                            <span className="text-muted-foreground text-sm font-medium">
                              Chưa chọn kênh nào — bấm để mở danh sách Fanpage
                            </span>
                          ) : (
                            <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                              {shownChannels.map((channelId) => {
                                const resolved = channelLabels.get(channelId);
                                const label = resolved?.name ?? channelId;
                                const gone = resolved?.note === "removed";
                                const off = resolved?.note === "disabled";

                                return (
                                  <span
                                    key={channelId}
                                    className="bg-muted/90 border-border/80 flex h-8 items-center gap-1.5 rounded-full border py-0 pr-3 pl-1 text-xs font-medium"
                                  >
                                    <span
                                      aria-hidden="true"
                                      style={avatarToneStyle(label)}
                                      className="flex size-6 items-center justify-center rounded-full text-[10px] font-bold"
                                    >
                                      {channelInitials(label)}
                                    </span>
                                    <span className="max-w-36 truncate text-xs">{label}</span>
                                    {gone || off ? (
                                      <span className="text-warning-foreground text-[10px] font-semibold">
                                        {gone ? "(đã gỡ)" : "(đang tắt)"}
                                      </span>
                                    ) : null}
                                  </span>
                                );
                              })}
                              {selectedIds.length > shownChannels.length ? (
                                <span className="text-primary bg-primary/10 rounded-full px-2.5 py-1 text-xs font-semibold">
                                  +{selectedIds.length - shownChannels.length} kênh khác
                                </span>
                              ) : null}
                            </span>
                          )}

                          <span className="flex-1" />
                          <span className="text-primary shrink-0 text-xs font-semibold group-hover:underline">
                            {selectedIds.length === 0 ? "Chọn kênh" : "Thay đổi"}
                          </span>
                        </button>

                        {/* Nhóm kênh đã lưu: bật/tắt cả nhóm trong một lần bấm. */}
                        {groupItems.length > 0 ? (
                          <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                            <span className="text-muted-foreground text-[11px] font-medium">
                              Nhóm có sẵn:
                            </span>
                            {groupItems.map((group) => {
                              const isAllSelected =
                                group.channelIds.length > 0 &&
                                group.channelIds.every((id) => selected.has(id));
                              return (
                                <button
                                  key={group.id}
                                  type="button"
                                  disabled={isRunning}
                                  aria-pressed={isAllSelected}
                                  onClick={() => toggleGroup(group.channelIds, !isAllSelected)}
                                  className={cn(
                                    "rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors",
                                    isAllSelected
                                      ? "bg-primary text-primary-foreground border-primary"
                                      : "bg-card text-foreground border-border hover:bg-muted/60",
                                  )}
                                >
                                  {group.name} ({group.channelIds.length})
                                </button>
                              );
                            })}
                          </div>
                        ) : null}

                        {/* Nói thẳng: thiếu câu này thì danh sách âm thầm tụt về mã kênh
                              và không ai biết đó có phải chuyện bình thường không. */}
                        {channels.isError ? (
                          <p className="text-muted-foreground text-xs">
                            Không tải được tên Page nên danh sách đang hiện mã kênh. Vẫn chọn và
                            chạy được bình thường.
                          </p>
                        ) : null}

                        <div className="flex items-center justify-between text-xs text-muted-foreground pt-0.5">
                          <span>
                            {selectedIds.length === 0
                              ? "Chọn ít nhất 1 kênh để tiến hành chạy."
                              : `Đã chọn ${selectedIds.length} kênh · Mỗi mã sẽ tạo ${selectedIds.length} bài.`}
                          </span>
                          <Link
                            href="/channels?tab=groups"
                            className="hover:text-primary font-medium text-foreground underline underline-offset-4 transition-colors inline-flex items-center gap-1"
                          >
                            Quản lý nhóm kênh
                          </Link>
                        </div>

                        {channels.isError ? (
                          <p className="text-muted-foreground text-xs">
                            Không tải được tên Page nên danh sách đang hiện mã kênh. Vẫn chọn và chạy được bình thường.
                          </p>
                        ) : null}

                        {prune.changed ? (
                          <div
                            role="status"
                            className="border-warning/40 bg-warning/10 text-warning-foreground flex items-start gap-2.5 rounded-xl border p-3 text-sm"
                          >
                            <p className="text-xs leading-relaxed">
                              <strong>{prune.removedLabels.length} Page</strong> đã tick sẽ KHÔNG được đăng vì kênh đang tắt hoặc đã bị gỡ:{" "}
                              <span className="font-medium">{prune.removedLabels.join(", ")}</span>. Bật lại ở màn Kênh nếu vẫn muốn đăng.
                            </p>
                          </div>
                        ) : null}

                        {channelError ? (
                          <p role="alert" className="text-destructive text-sm font-semibold">
                            {channelError}
                          </p>
                        ) : null}
                      </div>
                    </StepCard>

                    {/* Step 3: Caption */}
                    <StepCard
                      step="3"
                      title="Nội dung caption"
                      description="Chọn cách viết nội dung cho từng bài đăng"
                      railLabel="Caption"
                      railDetail={captionMode === "ai" ? "AI sáng tạo" : "Mẫu chung"}
                      isDone
                    >
                      <fieldset className="space-y-3.5" aria-describedby={`${captionModeId}-hint`}>
                        <legend className="sr-only">Cách viết caption</legend>

                        {/* Interactive Visual Cards for Caption Mode */}
                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                          {BULK_CAPTION_MODES.map((mode) => {
                            const isSelected = captionMode === mode;
                            return (
                              <label
                                key={mode}
                                className={`relative flex cursor-pointer flex-col justify-between rounded-xl border p-4 transition-all ${isSelected
                                  ? "border-primary bg-primary/[0.04] ring-2 ring-primary/25 shadow-sm"
                                  : "border-border bg-card hover:border-border/80 hover:bg-muted/20"
                                  } ${isRunning ? "opacity-60 cursor-not-allowed" : ""}`}
                              >
                                <div className="space-y-2">
                                  <div className="flex items-center justify-between">
                                    <div className="flex items-center gap-2">
                                      <input
                                        type="radio"
                                        value={mode}
                                        className="accent-primary size-4"
                                        disabled={isRunning}
                                        {...form.register("captionMode")}
                                      />
                                      <span className="text-sm font-semibold text-foreground">
                                        {BULK_CAPTION_MODE_LABELS[mode]}
                                      </span>
                                    </div>
                                    {mode === "ai" ? (
                                      <Badge tone="info">Khuyên dùng</Badge>
                                    ) : (
                                      <Badge tone="neutral">Tiết kiệm</Badge>
                                    )}
                                  </div>
                                  <p className="text-muted-foreground text-xs leading-relaxed">
                                    {mode === "ai"
                                      ? "AI tự động đọc dữ liệu sản phẩm, chất liệu và phong cách để viết caption thu hút riêng cho từng mã."
                                      : "Sử dụng một mẫu chuẩn chung, tự động điền {code} và {name} theo từng sản phẩm mà không cần AI."}
                                  </p>
                                </div>
                              </label>
                            );
                          })}
                        </div>

                        {captionMode === "ai" ? (
                          <div className="space-y-1.5 pt-1">
                            <label
                              htmlFor={captionToneId}
                              className="text-foreground block text-sm font-medium"
                            >
                              Phong cách nội dung
                            </label>
                            <Select
                              id={captionToneId}
                              disabled={isRunning}
                              aria-describedby={`${captionToneId}-hint`}
                              {...form.register("captionTone")}
                              className="max-w-xs"
                            >
                              {CAPTION_TONES.map((tone) => (
                                <option key={tone} value={tone}>
                                  {CAPTION_TONE_LABELS[tone]}
                                </option>
                              ))}
                            </Select>
                            <p
                              id={`${captionToneId}-hint`}
                              className="text-muted-foreground text-[11px] leading-relaxed"
                            >
                              {captionTone === DEFAULT_CAPTION_TONE
                                ? "Để AI tự quyết giọng viết — giống hệt cách chạy trước nay."
                                : "Áp dụng cho mọi mã trong lượt chạy này."}
                            </p>
                          </div>
                        ) : null}

                        <p id={`${captionModeId}-hint`} className="text-muted-foreground text-[11px] leading-relaxed flex items-center gap-1">
                          Bảo mật: Caption chỉ lấy Tên, Mô tả, Chủng loại, Mùa vụ. Giá bán và số lượng tồn kho không bao giờ đi vào bài đăng.
                        </p>

                        {captionMode === "template" ? (
                          <div className="space-y-3.5 pt-1">
                            <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 items-start">
                              {/* Left side: Template Editor */}
                              <div className="space-y-3">
                                <div className="flex items-center justify-between">
                                  <label htmlFor={templateId} className="text-sm font-medium text-foreground">
                                    Mẫu caption dùng chung
                                  </label>
                                  {/* Preset buttons */}
                                  <div className="flex items-center gap-1.5">
                                    <button
                                      type="button"
                                      onClick={() =>
                                        form.setValue(
                                          "captionTemplate",
                                          "{name} — Mã: {code}\nChất liệu cao cấp, form chuẩn đẹp.\nInbox shop để nhận tư vấn size ngay!",
                                          { shouldValidate: true },
                                        )
                                      }
                                      className="text-[11px] text-primary hover:underline font-medium"
                                    >
                                      Mẫu tư vấn
                                    </button>
                                    <span className="text-muted-foreground text-[10px]">·</span>
                                    <button
                                      type="button"
                                      onClick={() =>
                                        form.setValue(
                                          "captionTemplate",
                                          "BST MỚI VỀ: {name} (Mã {code})\nSố lượng có hạn, kiểm tra hàng trước khi nhận.",
                                          { shouldValidate: true },
                                        )
                                      }
                                      className="text-[11px] text-primary hover:underline font-medium"
                                    >
                                      Mẫu BST mới
                                    </button>
                                  </div>
                                </div>

                                <Textarea
                                  id={templateId}
                                  {...form.register("captionTemplate")}
                                  rows={5}
                                  disabled={isRunning}
                                  aria-invalid={form.formState.errors.captionTemplate ? true : undefined}
                                  aria-describedby={`${templateId}-hint`}
                                  placeholder={"{name} — mã {code}\nInbox để được tư vấn size và xem bảng màu mới nhất!"}
                                  className="font-mono text-sm leading-relaxed"
                                />

                                {/* Interactive Variable Insertion Buttons */}
                                <div className="flex flex-wrap items-center gap-1.5 text-xs">
                                  <span className="text-muted-foreground text-[11px]">Chèn nhanh biến:</span>
                                  {CAPTION_TEMPLATE_VARIABLES.map((name) => (
                                    <button
                                      key={name}
                                      type="button"
                                      onClick={() => handleInsertVariable(name)}
                                      className="bg-muted hover:bg-muted/80 text-foreground border border-border/80 px-2 py-0.5 rounded text-[11px] font-mono font-semibold transition-colors inline-flex items-center gap-0.5"
                                    > {"{" + name + "}"}
                                    </button>
                                  ))}
                                </div>

                                {form.formState.errors.captionTemplate ? (
                                  <p role="alert" className="text-destructive text-sm font-semibold">
                                    {form.formState.errors.captionTemplate.message}
                                  </p>
                                ) : null}
                                {unknownVariables.length > 0 ? (
                                  <p role="alert" className="text-warning-foreground text-xs">
                                    Không nhận ra biến {unknownVariables.map((name) => `{${name}}`).join(", ")} — sẽ giữ nguyên chữ trong bài đăng.
                                  </p>
                                ) : null}
                              </div>

                              {/* Right side: Live Facebook Post Mockup */}
                              <div className="space-y-2 rounded-xl border border-border/80 bg-muted/40 p-3.5">
                                <div className="flex items-center justify-between text-xs">
                                  <span className="font-semibold text-foreground flex items-center gap-1.5"> Xem trước bài đăng thực tế:
                                  </span>
                                  {parsed.codes.length > 1 ? (
                                    <div className="flex items-center gap-1">
                                      <span className="text-muted-foreground text-[11px]">Mã thử:</span>
                                      <select
                                        value={previewCodeIndex}
                                        onChange={(e) => setPreviewCodeIndex(Number(e.target.value))}
                                        className="bg-card border-border rounded px-2 py-0.5 text-xs font-mono font-medium"
                                      >
                                        {parsed.codes.slice(0, 10).map((c, i) => (
                                          <option key={c.code} value={i}>
                                            #{i + 1} {c.code}
                                          </option>
                                        ))}
                                      </select>
                                    </div>
                                  ) : (
                                    <span className="text-muted-foreground font-mono">Mã: {currentPreviewCode || "(chưa có)"}</span>
                                  )}
                                </div>
                                <div className="rounded-xl border border-border bg-card p-3 shadow-xs space-y-2.5">
                                  <div className="flex items-center gap-2">
                                    <div className="size-7 rounded-full bg-primary/20 flex items-center justify-center text-primary font-bold text-xs">
                                      V
                                    </div>
                                    <div>
                                      <p className="text-xs font-semibold text-foreground leading-none">
                                        Trang của bạn
                                      </p>
                                      <span className="text-[10px] text-muted-foreground">Vừa xong · Công khai</span>
                                    </div>
                                  </div>
                                  <pre className="text-xs break-words whitespace-pre-wrap text-foreground font-sans leading-relaxed min-h-16">
                                    {captionTemplate.trim().length > 0
                                      ? renderCaptionTemplate(captionTemplate, {
                                        code: currentPreviewCode || "(mã sản phẩm)",
                                        name: "(tên sản phẩm)",
                                      })
                                      : "Nội dung caption sẽ hiển thị tại đây khi bạn nhập mẫu..."}
                                  </pre>
                                </div>
                              </div>
                            </div>
                          </div>
                        ) : null}
                      </fieldset>
                    </StepCard>

                    {/* Step 4: Giờ đăng & Kích hoạt */}
                    <StepCard
                      step="4"
                      title="Thời gian đăng"
                      description="Đăng ngay hoặc hẹn giờ cho toàn bộ danh sách"
                      railLabel="Chạy"
                      railDetail={
                        isRunning
                          ? "Đang chạy"
                          : estimatedTotalPosts > 0
                            ? `${estimatedTotalPosts} bài`
                            : "Chờ cấu hình"
                      }
                      isDone={phase === "finished"}
                      isLast
                    >
                      <SchedulePicker
                        choice={schedule}
                        disabled={isRunning}
                        disabledReason="Lô đang chạy — chờ chạy xong rồi mới đổi được giờ đăng."
                        scopeNote="Áp dụng cho mọi mã và mọi kênh trong lượt chạy này. Các bài không lên cùng lúc — xem khoảng giãn cách ngay dưới."
                      />

                      {/*
                        Giãn cách RIÊNG cho lượt chạy này. Bỏ trống thì máy chủ
                        dùng cấu hình của công ty, đúng hành vi trước nay.
                        PENDING(E1): khoảng cách tính giữa các bài của CÙNG MỘT
                        kênh; hai kênh khác nhau không chờ nhau.
                      */}
                      <div className="border-border space-y-1.5 border-t pt-5">
                        <label htmlFor={spacingId} className="block text-sm font-medium">
                          Giãn cách giữa các bài (phút)
                        </label>
                        <Input
                          id={spacingId}
                          type="number"
                          inputMode="numeric"
                          min={0}
                          max={MAX_SPACING_MS / MS_PER_MINUTE}
                          step={1}
                          placeholder="Theo cấu hình công ty"
                          disabled={isRunning}
                          aria-describedby={`${spacingId}-hint`}
                          aria-invalid={form.formState.errors.spacingMinutes ? true : undefined}
                          className="max-w-45"
                          {...form.register("spacingMinutes")}
                        />
                        <p id={`${spacingId}-hint`} className="text-muted-foreground text-xs">
                          Nên để tối thiểu {RECOMMENDED_MIN_SPACING_MS / MS_PER_MINUTE} phút. Bỏ
                          trống để dùng cấu hình của công ty; nhập 0 để đăng liên tục.
                        </p>

                        {/* Lời khuyên, KHÔNG phải hàng rào: máy chủ vẫn nhận số
                            nhỏ hơn, nên chỗ này chỉ được nhắc, không được chặn. */}
                        {isBelowRecommendedSpacing ? (
                          <p role="status" className="text-warning-foreground text-xs">
                            Dưới {RECOMMENDED_MIN_SPACING_MS / MS_PER_MINUTE} phút — vẫn chạy được,
                            nhưng các bài lên sát nhau hơn mức khuyên dùng.
                          </p>
                        ) : null}

                        {form.formState.errors.spacingMinutes ? (
                          <p role="alert" className="text-destructive text-xs">
                            {form.formState.errors.spacingMinutes.message}
                          </p>
                        ) : null}
                      </div>

                      <div className="border-border space-y-3.5 border-t pt-5">
                        {/* Con số của lượt chạy, nói ngay cạnh nút bấm. */}
                        {estimatedTotalPosts > 0 ? (
                          <p className="text-muted-foreground text-sm">
                            Lượt này tạo{" "}
                            <span className="text-foreground font-medium tabular-nums">
                              {estimatedTotalPosts} bài
                            </span>{" "}
                            ({totalCodesCount} mã × {totalChannelsCount} kênh), chạy khoảng{" "}
                            <span className="tabular-nums">~{estimatedDurationMinutes} phút</span>.
                          </p>
                        ) : null}

                        <div className="flex flex-wrap items-center gap-3">
                          {/* Việc cuối của màn nằm ở cuối màn: sau khi đã chọn xong
                              mã, kênh, caption và giờ đăng. */}
                          <Button
                            type="submit"
                            size="lg"
                            disabled={isRunning || gate.isDisabled || hasNoCodes}
                          >
                            {isRunning
                              ? "Đang chạy lượt này…"
                              : hasNoCodes
                                ? schedule.mode === "scheduled"
                                  ? "Hẹn giờ"
                                  : "Khởi chạy"
                                : schedule.mode === "scheduled"
                                  ? `Hẹn giờ ${totalCodesCount} mã (${estimatedTotalPosts} bài)`
                                  : `Khởi chạy ${totalCodesCount} mã (${estimatedTotalPosts} bài)`}
                          </Button>

                          {isRunning ? (
                            <Button
                              type="button"
                              variant="destructive"
                              onClick={run.stop}
                              disabled={phase === "stopping"}
                            >
                              {phase === "stopping" ? "Đang dừng…" : "Dừng lượt chạy"}
                            </Button>
                          ) : null}

                          {phase === "finished" ? (
                            <Button type="button" variant="outline" onClick={run.reset}>
                              Xoá kết quả để chạy lượt mới
                            </Button>
                          ) : null}

                          <ReadOnlyNotice reason={runBlockedReason} className="basis-full" />
                        </div>

                        <p className="text-muted-foreground text-xs leading-relaxed">
                          {TAB_BOUNDARY_NOTICE}
                        </p>
                      </div>
                    </StepCard>
                  </form>
                </div>

                {/* Right column: what the run is doing, right now. */}
                <div className="space-y-5 lg:col-span-5 lg:sticky lg:top-4">
                  <section
                    aria-labelledby="bulk-progress-heading"
                    className={cn(
                      "space-y-3.5 rounded-xl border p-5",
                      // Viền đứt khi chưa có gì: khung đang chờ được lấp đầy,
                      // chứ không phải một thẻ rỗng ai đó quên xoá.
                      rows.length === 0
                        ? "border-border border-dashed"
                        : "border-border bg-card shadow-xs",
                    )}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <h2
                        id="bulk-progress-heading"
                        className="text-foreground text-base font-semibold"
                      >
                        Tiến độ
                      </h2>
                      <div className="flex items-center gap-2">
                        {isRunning ? (
                          <Badge tone="info">
                            <span
                              aria-hidden="true"
                              className="bg-primary size-1.5 rounded-full motion-safe:animate-pulse"
                            />
                            Đang chạy
                          </Badge>
                        ) : phase === "finished" ? (
                          <Badge tone="success">Đã hoàn tất</Badge>
                        ) : null}
                        <span className="text-muted-foreground font-mono text-xs tabular-nums">
                          {progressPercent}%
                        </span>
                      </div>
                    </div>

                    <div aria-hidden="true" className="border-border border-t" />

                    {/* Rule 5: máy chủ bỏ tông giọng thì phải nói, không được để
                        ô chọn nói một đằng còn caption viết một nẻo. */}
                    {toneDropped ? (
                      <p
                        role="status"
                        className="border-warning/40 bg-warning/10 text-warning-foreground rounded-md border px-3 py-2 text-xs"
                      >
                        Máy chủ chưa nhận phong cách nội dung nên caption của lượt này được viết
                        bằng giọng mặc định.
                      </p>
                    ) : null}

                    {rows.length === 0 ? (
                      <EmptyState
                        kind="idle"
                        title="Chưa chạy lượt nào"
                        description="Nhập mã, chọn kênh rồi bấm “Chạy”. Bảng này sẽ hiện trạng thái của từng mã ngay khi bắt đầu."
                        action={
                          <Link
                            href="/posts?tab=log"
                            className="text-primary text-sm font-medium underline underline-offset-4"
                          >
                            Xem nhật ký các lượt trước
                          </Link>
                        }
                      />
                    ) : (
                      <div className="space-y-3.5">
                        {/* Live Progress Card */}
                        <div
                          ref={summaryRef}
                          tabIndex={-1}
                          role={phase === "finished" ? "alert" : undefined}
                          className="border-border/90 bg-card space-y-4 rounded-xl border p-5 shadow-sm outline-none"
                        >
                          {/* Progress bar with percentage */}
                          <div className="space-y-2">
                            <div className="flex items-center justify-between text-xs font-semibold">
                              <span className="text-foreground">
                                Đã xử lý: {summary.processed}/{summary.total} mã
                              </span>
                              <span className="font-mono text-sm font-bold tabular-nums text-primary">
                                {progressPercent}%
                              </span>
                            </div>
                            <Progress
                              value={summary.processed}
                              max={summary.total}
                              label="Tiến độ lượt chạy"
                              valueText={`Đã xử lý ${summary.processed}/${summary.total} mã`}
                            />
                          </div>

                          {/* Metric stats grid */}
                          <div className="grid grid-cols-3 gap-2">
                            <div className="border-success/30 bg-success/10 rounded-xl border p-2.5 text-center shadow-2xs">
                              <span className="text-success-foreground block font-mono text-lg font-bold tabular-nums">
                                {summary.done}
                              </span>
                              <span className="text-success-foreground text-[11px] font-medium">Thành công</span>
                            </div>
                            <div className="border-warning/30 bg-warning/10 rounded-xl border p-2.5 text-center shadow-2xs">
                              <span className="text-warning-foreground block font-mono text-lg font-bold tabular-nums">
                                {summary.skipped}
                              </span>
                              <span className="text-warning-foreground text-[11px] font-medium">Bỏ qua</span>
                            </div>
                            <div className="border-destructive/30 bg-destructive/10 rounded-xl border p-2.5 text-center shadow-2xs">
                              <span className="text-destructive block font-mono text-lg font-bold tabular-nums">
                                {summary.failed}
                              </span>
                              <span className="text-destructive text-[11px] font-medium">Lỗi</span>
                            </div>
                          </div>

                          {/* Status sentence */}
                          <p role="status" aria-live="polite" className="text-muted-foreground text-xs leading-relaxed">
                            {summary.cancelled > 0
                              ? `${summary.cancelled} mã chưa chạy nên không bị ảnh hưởng gì. `
                              : ""}
                            {ranScheduled
                              ? "Các lô đã tạo đang chờ tới giờ hẹn — đổi giờ hoặc huỷ ở "
                              : "Các lô đã tạo chạy tiếp trên máy chủ kể cả khi bạn rời trang — xem ở "}
                            {ranScheduled ? (
                              <Link
                                href="/posts?tab=scheduled"
                                className="underline underline-offset-4 font-semibold text-foreground hover:text-primary"
                              >
                                Bài đã hẹn
                              </Link>
                            ) : (
                              <Link
                                href="/posts?tab=log"
                                className="underline underline-offset-4 font-semibold text-foreground hover:text-primary"
                              >
                                Nhật ký đăng
                              </Link>
                            )}
                            .
                          </p>
                        </div>

                        {/* Filter tabs */}
                        <div className="flex items-center justify-between gap-2 pt-1">
                          <div className="bg-muted/40 p-0.5 rounded-lg border border-border/60 flex items-center gap-1">
                            <button
                              type="button"
                              onClick={() => setTableFilter("all")}
                              className={`rounded-md px-2.5 py-1 text-xs font-semibold transition-all ${tableFilter === "all"
                                ? "bg-card text-foreground shadow-xs"
                                : "text-muted-foreground hover:text-foreground"
                                }`}
                            >
                              Tất cả ({rows.length})
                            </button>
                            <button
                              type="button"
                              onClick={() => setTableFilter("done")}
                              className={`rounded-md px-2.5 py-1 text-xs font-semibold transition-all ${tableFilter === "done"
                                ? "bg-card text-success-foreground shadow-xs"
                                : "text-muted-foreground hover:text-foreground"
                                }`}
                            >
                              Thành công ({summary.done})
                            </button>
                            <button
                              type="button"
                              onClick={() => setTableFilter("issues")}
                              className={`rounded-md px-2.5 py-1 text-xs font-semibold transition-all ${tableFilter === "issues"
                                ? "bg-card text-destructive shadow-xs"
                                : "text-muted-foreground hover:text-foreground"
                                }`}
                            >
                              Bỏ qua & Lỗi ({summary.skipped + summary.failed})
                            </button>
                          </div>
                          {tableFilter !== "all" ? (
                            <span className="text-[11px] text-muted-foreground font-mono">
                              Đang lọc: {filteredRows.length} dòng
                            </span>
                          ) : null}
                        </div>

                        {/* Detail Progress Table */}
                        <BulkProgressTable rows={filteredRows} />
                      </div>
                    )}
                  </section>
                </div>
              </div>
            </div>
          </LayoutContent>
        }
      />
      <ChannelPickerDialog
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        applied={runnableSelection}
        onApply={(channelIds) => {
          setChannelError(null);
          setSelected(new Set(channelIds));
        }}
        readOnlyReason={gate.reason}
      />
    </>
  );
}

/**
 * Clean Step Card container with modern visual hierarchy and status badges.
 */
function StepCard({
  step,
  title,
  description,
  badge,
  railLabel,
  railDetail,
  isDone = false,
  isLast = false,
  children,
}: {
  step: string;
  title: string;
  description?: string;
  badge?: ReactNode;
  /** Chữ ngắn trên dải bước bên trái — không phải tiêu đề thẻ. */
  railLabel: string;
  /** Trạng thái một dòng của bước đó: "Chưa nhập", "3 kênh", "Đang chạy". */
  railDetail: string;
  isDone?: boolean;
  /** Bước cuối không kẻ tiếp đường nối xuống dưới. */
  isLast?: boolean;
  children: ReactNode;
}) {
  const labelId = useId();

  return (
    <div className="flex gap-4">
      {/*
        Dải bước sống TRONG từng thẻ chứ không phải một cột riêng: các thẻ cao
        thấp rất khác nhau, nên một cột rail rời sẽ không bao giờ thẳng hàng với
        thẻ nó đang nói tới. `aria-hidden`: số bước và trạng thái đã có trong
        chính thẻ, đọc lại lần nữa chỉ làm dài thêm cho trình đọc màn hình.
      */}
      <div aria-hidden="true" className="hidden w-16 shrink-0 flex-col items-center lg:flex">
        <span
          className={cn(
            "grid size-8 shrink-0 place-items-center rounded-full border font-mono text-xs font-semibold",
            isDone
              ? "border-primary bg-primary text-primary-foreground"
              : "border-border bg-card text-muted-foreground",
          )}
        >
          {step}
        </span>
        <span className="text-foreground-subtle mt-1.5 text-center font-mono text-[10px] tracking-[0.14em] uppercase">
          {railLabel}
        </span>
        <span className="text-muted-foreground text-center text-[10px] leading-tight">
          {railDetail}
        </span>
        {isLast ? null : <span className="bg-border mt-2 w-px flex-1" />}
      </div>

      <section aria-labelledby={labelId} className="min-w-0 flex-1">
        {/*
          Mấu thẻ mẫu thò ra khỏi tay áo (DESIGN.md): nhãn dệt mono ngồi trên một
          mấu nhô lên khỏi mép thẻ. Là `<p>`, không phải heading — thẻ vẫn có tên
          cho trình đọc màn hình mà không thêm một mục nữa vào outline bên cạnh
          nhãn của từng ô nhập bên trong.
        */}
        <div className="bg-muted ml-4 inline-block rounded-t-md px-3.5 py-1.5">
          <Eyebrow id={labelId}>
            Bước {step} — {title}
          </Eyebrow>
        </div>

        <div className="border-border bg-card space-y-4 rounded-xl border p-5 shadow-xs">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-foreground text-base font-semibold">{title}</p>
              {description ? (
                <p className="text-muted-foreground mt-0.5 text-xs leading-normal">{description}</p>
              ) : null}
            </div>
            {badge ? <div className="shrink-0">{badge}</div> : null}
          </div>
          {children}
        </div>
      </section>
    </div>
  );
}

/**
 * Modern structured scope disclosure with rich card visual hierarchy.
 */
function ScopeDisclosure({
  id,
  isOpen,
  onOpenChange,
}: {
  id: string;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <section
      id={id}
      aria-label="Chi tiết cách chạy hàng loạt"
      className="border-border bg-card rounded-md border px-2"
    >
      <Collapsible
        isOpen={isOpen}
        onOpenChange={onOpenChange}
        trigger={<span className="text-sm font-medium">Chi tiết</span>}
      >
        <div className="grid grid-cols-1 gap-3 px-2 pb-3 md:grid-cols-2">
          <div className="space-y-1.5">
            <p className="text-foreground text-xs font-semibold">Màn này đăng bài ảnh</p>
            <p className="text-muted-foreground text-xs leading-relaxed">
              Bài video đơn và Reels phải chọn đích rồi kiểm thông số từng clip, nên chúng đi
              qua màn{" "}
              <Link href="/compose" className="text-primary font-medium underline underline-offset-4">
                Soạn bài
              </Link>
              .
            </p>
          </div>

          <div className="space-y-1.5">
            <p className="text-foreground text-xs font-semibold">Chạy tuần tự, đóng tab thì sao</p>
            <p className="text-muted-foreground text-xs leading-relaxed">
              Mỗi mã lần lượt được tra sản phẩm, lấy caption rồi tạo lô. {TAB_BOUNDARY_NOTICE}
            </p>
          </div>
        </div>
      </Collapsible>
    </section>
  );
}
