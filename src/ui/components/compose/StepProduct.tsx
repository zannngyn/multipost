"use client";

import { useId } from "react";
import { useWatch } from "react-hook-form";

import { cn } from "@/shared/utils";
import { ApiErrorNotice } from "@/ui/components/feedback/ApiErrorNotice";
import { EmptyState } from "@/ui/components/feedback/EmptyState";
import { MediaGrid } from "@/ui/components/compose/MediaGrid";
import { ProductPicker } from "@/ui/components/compose/ProductPicker";
import { SegmentedField } from "@/ui/components/compose/SegmentedField";
import { UploadPanel } from "@/ui/components/compose/UploadPanel";
import { VideoSpecCard } from "@/ui/components/compose/VideoSpecCard";
import { Badge } from "@/ui/components/ui/badge";
import { Button } from "@/ui/components/ui/button";
import { useDelayedFlag } from "@/ui/hooks/useDelayedFlag";
import type { ComposeWizard } from "@/ui/hooks/useComposeWizard";
import {
  INVENTORY_STATUS_LABELS,
  MEDIA_KINDS,
  MEDIA_KIND_HINTS,
  MEDIA_KIND_LABELS,
  MEDIA_SOURCES,
  MEDIA_SOURCE_HINTS,
  MEDIA_SOURCE_LABELS,
  VIDEO_TARGETS,
  VIDEO_TARGET_HINTS,
  VIDEO_TARGET_LABELS,
  type ComposeResponse,
} from "@/ui/schemas/compose.schema";

/**
 * Step 1 — pick the product: type or pick a code, choose what kind of post it
 * is, pull the sheet row, the stock gate and the album.
 *
 * Laid out as the approved design draws it: ONE tall field at the top (the code
 * is the only thing that starts a post), a resolved line that replaces the field
 * with facts once the lookup answered, then the short settings as segmented
 * rows, then the album.
 *
 * Business rule 2 lives visibly in this file: `ContentFacts` renders the four
 * whitelisted columns on a raised surface, and everything about stock sits in a
 * SEPARATE, sunken, clearly labelled block beside it. The two are never merged,
 * however well they would fit together — the split IS the rule, made visible.
 *
 * The step's own action ("Tra dữ liệu") stays here: it is not "go to the next
 * step", it is "fetch this product". The wizard footer owns the step change.
 */
export function StepProduct({ wizard }: { wizard: ComposeWizard }) {
  const fieldId = useId();
  const { form, compose, composed } = wizard;
  const errors = form.formState.errors;
  const showSkeleton = useDelayedFlag(compose.isPending);
  // `useWatch` (not `form.watch()`): the destination block must appear the
  // instant "Video" is picked, and the value re-renders nothing else.
  const mediaKind = useWatch({ control: form.control, name: "mediaKind" }) ?? "image";
  const source = useWatch({ control: form.control, name: "source" }) ?? "drive";
  const videoTarget = useWatch({ control: form.control, name: "videoTarget" }) ?? "facebook_video";
  const productCode = useWatch({ control: form.control, name: "productCode" }) ?? "";
  const color = useWatch({ control: form.control, name: "color" }) ?? "";

  const hasTypedCaption = Object.values(wizard.captionValues ?? {}).some(
    (text) => text.trim().length > 0,
  );

  const codeHintId = `${fieldId}-code-hint`;
  const codeErrorId = `${fieldId}-code-error`;

  function lookUp() {
    void wizard.submitProductStep();
  }

  return (
    <div className="flex flex-col gap-5">
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          lookUp();
        }}
        className="bg-card border-border flex flex-col gap-5 rounded-2xl border p-5"
      >
        <div className="flex flex-col gap-2">
          <label htmlFor={`${fieldId}-code`} className="text-sm font-medium">
            Mã sản phẩm
          </label>

          <ProductPicker
            id={`${fieldId}-code`}
            register={form.register("productCode")}
            value={productCode}
            onSelectCode={(code) =>
              form.setValue("productCode", code, { shouldDirty: true, shouldValidate: true })
            }
            onSubmit={lookUp}
            disabled={compose.isPending}
            invalid={Boolean(errors.productCode)}
            describedBy={errors.productCode ? `${codeErrorId} ${codeHintId}` : codeHintId}
          />

          {errors.productCode ? (
            <p id={codeErrorId} role="alert" className="text-destructive text-xs">
              {errors.productCode.message}
            </p>
          ) : null}

          {composed ? (
            <ResolvedLine
              id={codeHintId}
              composed={composed}
              albumCount={wizard.album.length}
              onChangeProduct={() => {
                form.setValue("productCode", "", { shouldDirty: true });
                form.setValue("color", "", { shouldDirty: true });
                form.setFocus("productCode");
              }}
            />
          ) : (
            <p id={codeHintId} className="text-muted-foreground text-xs leading-relaxed">
              Gõ vài ký tự đầu của mã rồi chọn trong danh sách, hoặc gõ hết mã và bấm “Tra dữ liệu
              sản phẩm”. Mã đã hết hàng không đăng được — danh sách nói rõ ngay khi bạn chọn.
            </p>
          )}
        </div>

        <span aria-hidden="true" className="bg-border h-px" />

        <div className="flex flex-wrap items-start gap-x-8 gap-y-4">
          {/* Two fixed options with a one-line meaning each -> segmented track. */}
          <SegmentedField
            legend="Kiểu bài"
            name="mediaKind"
            value={mediaKind}
            options={MEDIA_KINDS.map((kind) => ({
              value: kind,
              label: MEDIA_KIND_LABELS[kind],
              hint: MEDIA_KIND_HINTS[kind],
            }))}
            register={form.register("mediaKind")}
            disabled={compose.isPending}
            error={errors.mediaKind?.message}
            className="max-w-md"
          />

          {mediaKind === "video" ? (
            <SegmentedField
              legend="Đích đăng video"
              name="videoTarget"
              value={videoTarget}
              options={VIDEO_TARGETS.map((target) => ({
                value: target,
                label: VIDEO_TARGET_LABELS[target],
                hint: VIDEO_TARGET_HINTS[target],
              }))}
              register={form.register("videoTarget")}
              disabled={compose.isPending}
              error={errors.videoTarget?.message}
              className="max-w-md"
            />
          ) : null}

          {/* Brief §8: two file modes, sharing everything downstream. */}
          <SegmentedField
            legend="Nguồn file"
            name="source"
            value={source}
            options={MEDIA_SOURCES.map((value) => ({
              value,
              label: MEDIA_SOURCE_LABELS[value],
              hint: MEDIA_SOURCE_HINTS[value],
            }))}
            register={form.register("source")}
            disabled={compose.isPending || wizard.upload.isPending}
            error={errors.source?.message}
            className="max-w-md"
          />
        </div>

        {source === "upload" ? (
          <UploadPanel
            queue={wizard.uploadQueue}
            onQueueChange={wizard.setUploadQueue}
            onUpload={() => wizard.upload.mutate()}
            isUploading={wizard.upload.isPending}
            rejected={wizard.uploadRejections}
            uploadedCount={wizard.uploadedCount}
            disabled={compose.isPending}
          />
        ) : null}

        {source === "upload" && wizard.upload.isError ? (
          <ApiErrorNotice error={wizard.upload.error} onRetry={() => wizard.upload.mutate()} />
        ) : null}

        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" size="lg" className="h-11 px-5" disabled={compose.isPending}>
            {compose.isPending
              ? "Đang tra dữ liệu…"
              : mediaKind === "video"
                ? "Tra dữ liệu và kiểm video"
                : "Tra dữ liệu sản phẩm"}
          </Button>
          {hasTypedCaption ? (
            <p className="text-muted-foreground max-w-md text-xs leading-relaxed">
              Tra một mã khác sẽ xoá caption đang soạn — caption luôn gắn với đúng sản phẩm của nó.
            </p>
          ) : null}
        </div>

        <p className="sr-only" role="status" aria-live="polite">
          {compose.isPending ? "Đang tra dữ liệu sản phẩm" : ""}
        </p>
      </form>

      {wizard.captionsCleared ? (
        <p
          role="status"
          className="border-warning/40 bg-warning/10 text-warning-foreground rounded-xl border px-3.5 py-2.5 text-sm"
        >
          Caption của sản phẩm trước đã được xoá vì bạn đổi sang mã/màu khác.
        </p>
      ) : null}

      {compose.isPending ? (
        showSkeleton ? (
          <ComposeResultSkeleton />
        ) : null
      ) : compose.isError ? (
        <ApiErrorNotice error={compose.error} onRetry={() => compose.mutate()} />
      ) : composed ? (
        <ComposeResult
          composed={composed}
          album={wizard.album}
          activeColor={color}
          onPickColor={(next) => {
            form.setValue("color", next, { shouldDirty: true });
            lookUp();
          }}
          onReorder={wizard.setAlbum}
          disabled={compose.isPending}
        />
      ) : (
        <EmptyState
          kind="idle"
          title="Chưa tra mã nào"
          description={
            mediaKind === "video"
              ? "Nhập mã sản phẩm rồi bấm “Tra dữ liệu và kiểm video”. Hệ thống kiểm tồn kho trước, sau đó lấy clip từ Drive và kiểm thông số theo đích đăng đã chọn."
              : "Nhập mã sản phẩm rồi bấm “Tra dữ liệu sản phẩm”. Hệ thống sẽ kiểm tra tồn kho trước, sau đó gom ảnh từ Drive."
          }
        />
      )}
    </div>
  );
}

/**
 * The line that replaces the hint once a code resolved — the design's "✓ tên ·
 * … · Đổi sản phẩm" row.
 *
 * Price is NOT here, unlike the mock: the four caption-safe columns and the
 * internal stock block below own that information, and a summary line is the
 * easiest place for a forbidden field to sneak into a screenshot. Stock is
 * allowed (step 1 is the internal step) and is drawn as a status pill, visibly
 * apart from the product's name.
 */
function ResolvedLine({
  id,
  composed,
  albumCount,
  onChangeProduct,
}: {
  /** Same id the field's `aria-describedby` points at: this line IS the field's
      description once a code resolved. */
  id: string;
  composed: ComposeResponse;
  albumCount: number;
  onChangeProduct: () => void;
}) {
  const isVideo = Boolean(composed.video);

  return (
    <div id={id} className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 text-sm">
      <span
        aria-hidden="true"
        className="bg-success/25 text-success-foreground flex size-5 shrink-0 items-center justify-center rounded-full text-xs"
      >
        ✓
      </span>
      <span className="font-semibold">{composed.content.name}</span>
      <span className="text-muted-foreground font-mono text-xs">{composed.content.code}</span>
      <span aria-hidden="true" className="text-muted-foreground">
        ·
      </span>
      <span className="text-muted-foreground text-xs">
        {isVideo ? "1 clip" : `${albumCount} ảnh`}
      </span>

      {composed.inventory ? (
        <Badge tone={composed.inventory.status === "in_stock" ? "success" : "warning"}>
          {INVENTORY_STATUS_LABELS[composed.inventory.status]}
          {composed.inventory.stock !== null ? ` · tồn ${composed.inventory.stock}` : ""}
        </Badge>
      ) : null}

      <span className="flex-1" />

      <Button type="button" variant="ghost" size="sm" onClick={onChangeProduct}>
        Đổi sản phẩm
      </Button>
    </div>
  );
}

function ComposeResult({
  composed,
  album,
  activeColor,
  onPickColor,
  onReorder,
  disabled,
}: {
  composed: ComposeResponse;
  /** Publish order, which this step lets the operator rearrange. */
  album: readonly ComposeResponse["media"][number][];
  activeColor: string;
  onPickColor: (color: string) => void;
  onReorder: (next: ComposeResponse["media"][number][]) => void;
  disabled: boolean;
}) {
  return (
    <div className="flex flex-col gap-4">
      <ColorChoice
        colors={composed.availableColors}
        active={activeColor}
        onPick={onPickColor}
        disabled={disabled}
      />
      <div className="grid items-start gap-4 @3xl:grid-cols-[1.15fr_1fr]">
        <ContentFacts composed={composed} />
        <InternalOperatorInfo composed={composed} />
      </div>
      {composed.video ? <VideoSpecCard video={composed.video} clip={composed.media[0]} /> : null}
      {/* Reorder and remove both end the same way — the album on screen IS the
          album that gets published, so both write the same list back. */}
      <MediaGrid media={album} onReorder={onReorder} onRemove={onReorder} disabled={disabled} />
    </div>
  );
}

/**
 * "Màu đưa vào bài" — the colours this code actually has files for.
 *
 * The list comes from the SERVER (`availableColors`), already normalised by the
 * data pipeline, so TRANG and TRẮNG arrive as one entry and the operator never
 * has to know they were ever two (business rule: gộp biến thể).
 *
 * Buttons, not radios: picking a colour re-runs the whole lookup — Sheet, stock
 * gate, album — and a control that fires a request is an action, not a field.
 * Nothing is hidden: the caption warning below the form already says that
 * changing the colour clears a caption written for another one.
 */
function ColorChoice({
  colors,
  active,
  onPick,
  disabled,
}: {
  colors: readonly string[];
  active: string;
  onPick: (color: string) => void;
  disabled: boolean;
}) {
  if (colors.length === 0) return null;

  const normalised = active.trim().toLowerCase();

  return (
    <section aria-labelledby="color-heading" className="flex flex-col gap-2">
      <h3 id="color-heading" className="text-muted-foreground text-xs">
        Màu đưa vào bài — lấy từ tên file trên Drive
      </h3>
      <div className="flex flex-wrap gap-2">
        <ColorChip
          label="Mọi màu có ảnh"
          pressed={normalised.length === 0}
          disabled={disabled}
          onClick={() => onPick("")}
        />
        {colors.map((colorName) => (
          <ColorChip
            key={colorName}
            label={colorName}
            pressed={normalised === colorName.trim().toLowerCase()}
            disabled={disabled}
            onClick={() => onPick(colorName)}
          />
        ))}
      </div>
      <p className="text-muted-foreground text-xs leading-relaxed">
        Chọn một màu sẽ tra lại mã và chỉ lấy ảnh của màu đó. Bỏ chọn để hệ thống tự lấy màu có
        nhiều ảnh nhất.
      </p>
    </section>
  );
}

function ColorChip({
  label,
  pressed,
  disabled,
  onClick,
}: {
  label: string;
  pressed: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "focus-visible:ring-ring/50 border-border bg-card flex h-10 cursor-pointer items-center gap-2 rounded-xl border px-3.5 text-sm transition-colors outline-none focus-visible:ring-3 disabled:cursor-not-allowed disabled:opacity-60",
        pressed ? "border-primary bg-accent/25 ring-primary font-semibold ring-1" : "hover:bg-muted",
      )}
    >
      {label}
    </button>
  );
}

/** The ONLY product fields allowed near a caption (brief §2.2). */
function ContentFacts({ composed }: { composed: ComposeResponse }) {
  const { content } = composed;

  return (
    <section
      aria-labelledby="content-heading"
      className="bg-card border-border h-full rounded-2xl border p-5"
    >
      <div className="flex flex-wrap items-center gap-2.5 pb-3.5">
        <span aria-hidden="true" className="bg-primary size-2 rounded-full" />
        <h3 id="content-heading" className="text-base font-semibold">
          Thông tin đưa vào caption
        </h3>
        <span className="text-muted-foreground font-mono text-xs">{content.code}</span>
      </div>

      <dl className="grid grid-cols-[6.5rem_1fr] gap-x-3.5 gap-y-2.5 text-sm leading-relaxed">
        <Fact label="Tên sản phẩm" value={content.name} />
        <Fact label="Chủng loại" value={content.category} />
        <Fact label="Mùa vụ" value={content.season} />
        <Fact label="Mô tả" value={content.description} />
      </dl>

      <p className="border-border text-muted-foreground mt-3.5 border-t pt-3 text-xs leading-relaxed">
        Chỉ bốn trường trên được gửi cho AI và xuất hiện trong caption. Giá, tồn kho và ghi chú sản
        xuất không bao giờ đi kèm.
      </p>
    </section>
  );
}

/**
 * Internal operator notes — stock, warnings, colours found on Drive.
 * Deliberately OUTSIDE the caption block and never copied into a caption
 * (CLAUDE.md business rule 2 + brief §3). The sunken surface is the signal:
 * this panel is for the operator, not for the post.
 */
function InternalOperatorInfo({ composed }: { composed: ComposeResponse }) {
  const { inventory, warnings, availableColors } = composed;
  if (!inventory && warnings.length === 0 && availableColors.length === 0) return null;

  return (
    <section aria-labelledby="internal-heading" className="bg-muted h-full rounded-2xl p-5">
      <div className="flex flex-wrap items-center gap-2.5 pb-3.5">
        <span aria-hidden="true" className="bg-foreground-subtle size-2 rounded-full" />
        <h3 id="internal-heading" className="text-base font-semibold">
          Thông tin nội bộ — không đưa vào caption
        </h3>
      </div>

      <div className="flex flex-col gap-2 text-sm leading-relaxed">
        {inventory ? (
          <p>
            {INVENTORY_STATUS_LABELS[inventory.status]}
            {inventory.stock !== null ? ` · tồn ${inventory.stock}` : ""}
          </p>
        ) : null}
        {availableColors.length > 0 ? (
          <p className="text-muted-foreground">
            Màu có ảnh trên Drive: {availableColors.join(", ")}
          </p>
        ) : null}
      </div>

      {warnings.length > 0 ? (
        <ul className="mt-3.5 flex flex-col gap-2">
          {warnings.map((warning) => (
            <li
              key={warning}
              className="bg-warning/15 text-warning-foreground rounded-lg px-3 py-2.5 text-xs leading-relaxed"
            >
              {warning}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-muted-foreground mt-3.5 text-xs">Không có cảnh báo nào cho mã này.</p>
      )}
    </section>
  );
}

function Fact({ label, value }: { label: string; value: string | null }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={value && value.trim().length > 0 ? "font-medium" : "text-muted-foreground italic"}>
        {value && value.trim().length > 0 ? value : "(trống trên Sheet)"}
      </dd>
    </>
  );
}

function ComposeResultSkeleton() {
  return (
    <div aria-hidden="true" className="flex flex-col gap-4 motion-safe:animate-pulse">
      <div className="flex gap-2">
        {[0, 1, 2].map((chip) => (
          <div key={chip} className="bg-muted h-10 w-28 rounded-xl" />
        ))}
      </div>
      <div className="grid gap-4 @3xl:grid-cols-[1.15fr_1fr]">
        <div className="bg-card border-border h-52 rounded-2xl border" />
        <div className="bg-muted h-52 rounded-2xl" />
      </div>
      <div className="bg-card border-border grid grid-cols-2 gap-2.5 rounded-2xl border p-5 @2xl:grid-cols-5">
        <div className="bg-media-empty-cover col-span-2 row-span-2 aspect-square rounded-xl" />
        {[0, 1, 2, 3, 4, 5].map((cell) => (
          <div key={cell} className="bg-media-empty aspect-square rounded-xl" />
        ))}
      </div>
    </div>
  );
}
