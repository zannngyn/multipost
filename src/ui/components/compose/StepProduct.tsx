"use client";

import { useId } from "react";
import { useWatch, type UseFormRegisterReturn } from "react-hook-form";

import { cn } from "@/shared/utils";
import { ApiErrorNotice } from "@/ui/components/feedback/ApiErrorNotice";
import { EmptyState } from "@/ui/components/feedback/EmptyState";
import { MediaGrid } from "@/ui/components/compose/MediaGrid";
import { UploadPanel } from "@/ui/components/compose/UploadPanel";
import { VideoSpecCard } from "@/ui/components/compose/VideoSpecCard";
import { Button } from "@/ui/components/ui/button";
import { Input } from "@/ui/components/ui/input";
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
 * Step 1 — pick the product: type a code (and optionally a colour), pull the
 * sheet row, the stock gate and the album.
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

  const hasTypedCaption = Object.values(wizard.captionValues ?? {}).some(
    (text) => text.trim().length > 0,
  );

  return (
    <div className="flex max-w-6xl flex-col gap-5">
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void wizard.submitProductStep();
        }}
        className="flex flex-col gap-5"
      >
        <div className="grid gap-4 @xl:grid-cols-2 @3xl:grid-cols-3">
          <Field
            id={`${fieldId}-code`}
            label="Mã sản phẩm"
            hint="Ví dụ: MGKVX6310. Mã phải có trên Sheet và đã được đồng bộ."
            error={errors.productCode?.message}
          >
            {(props) => (
              <Input
                {...form.register("productCode")}
                {...props}
                placeholder="MGKVX6310"
                autoComplete="off"
                spellCheck={false}
                className="font-mono uppercase"
              />
            )}
          </Field>

          <Field
            id={`${fieldId}-color`}
            label="Màu (tuỳ chọn)"
            hint="Bỏ trống để hệ thống tự chọn. Viết TRANG hay TRẮNG đều được."
            error={errors.color?.message}
          >
            {(props) => (
              <Input {...form.register("color")} {...props} placeholder="TRẮNG" autoComplete="off" />
            )}
          </Field>
        </div>

        {/* Brief §8: two file modes, sharing everything downstream. */}
        <RadioField
          legend="Nguồn file"
          hint="Chế độ B dùng khi file chưa có trên Drive. Mã sản phẩm vẫn bắt buộc — Sheet và AI không đổi."
          name="source"
          options={MEDIA_SOURCES.map((value) => ({
            value,
            label: MEDIA_SOURCE_LABELS[value],
            hint: MEDIA_SOURCE_HINTS[value],
          }))}
          register={form.register("source")}
          disabled={compose.isPending || wizard.upload.isPending}
          error={errors.source?.message}
        />

        {/* Two fixed options -> radio (core-form-inputs: native first). */}
        <RadioField
          legend="Loại bài"
          hint="Bài ảnh gom 5–10 ảnh; bài video dùng đúng một clip và được kiểm thông số trước khi đăng."
          name="mediaKind"
          options={MEDIA_KINDS.map((kind) => ({
            value: kind,
            label: MEDIA_KIND_LABELS[kind],
            hint: MEDIA_KIND_HINTS[kind],
          }))}
          register={form.register("mediaKind")}
          disabled={compose.isPending}
          error={errors.mediaKind?.message}
        />

        {mediaKind === "video" ? (
          <RadioField
            legend="Đích đăng video"
            hint="Reels có ràng buộc chặt hơn Video thường; chọn sai thì clip bị chặn ngay ở bước này."
            name="videoTarget"
            options={VIDEO_TARGETS.map((target) => ({
              value: target,
              label: VIDEO_TARGET_LABELS[target],
              hint: VIDEO_TARGET_HINTS[target],
            }))}
            register={form.register("videoTarget")}
            disabled={compose.isPending}
            error={errors.videoTarget?.message}
          />
        ) : null}

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
          <Button type="submit" size="lg" className="h-10 px-5" disabled={compose.isPending}>
            {compose.isPending
              ? "Đang tra dữ liệu…"
              : mediaKind === "video"
                ? "Tra dữ liệu và kiểm video"
                : "Tra dữ liệu sản phẩm"}
          </Button>
          {hasTypedCaption ? (
            <p className="text-muted-foreground text-xs">
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

function ComposeResult({
  composed,
  album,
  onReorder,
  disabled,
}: {
  composed: ComposeResponse;
  /** Publish order, which this step lets the operator rearrange. */
  album: readonly ComposeResponse["media"][number][];
  onReorder: (next: ComposeResponse["media"][number][]) => void;
  disabled: boolean;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="grid items-start gap-4 @3xl:grid-cols-[1.15fr_1fr]">
        <ContentFacts composed={composed} />
        <InternalOperatorInfo composed={composed} />
      </div>
      {composed.video ? <VideoSpecCard video={composed.video} clip={composed.media[0]} /> : null}
      <MediaGrid media={album} onReorder={onReorder} disabled={disabled} />
    </div>
  );
}

/** The ONLY product fields allowed near a caption (brief §2.2). */
function ContentFacts({ composed }: { composed: ComposeResponse }) {
  const { content } = composed;

  return (
    <section
      aria-labelledby="content-heading"
      className="bg-card border-border h-full rounded-xl border p-5"
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
    <section aria-labelledby="internal-heading" className="bg-muted h-full rounded-xl p-5">
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

/** Field wrapper: label + hint + error wired together for assistive tech. */
function Field({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string;
  label: string;
  hint: string;
  error?: string;
  children: (props: {
    id: string;
    "aria-invalid": boolean;
    "aria-describedby": string;
  }) => React.ReactNode;
}) {
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;

  return (
    <div className="bg-card border-border flex flex-col gap-1.5 rounded-xl border p-4">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      {children({
        id,
        "aria-invalid": Boolean(error),
        "aria-describedby": error ? `${errorId} ${hintId}` : hintId,
      })}
      <p id={hintId} className="text-muted-foreground text-xs leading-relaxed">
        {hint}
      </p>
      {error ? (
        <p id={errorId} role="alert" className="text-destructive text-xs">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Radio group for a small fixed set (core-form-inputs: native `<input
 * type="radio">` first, no custom widget for two options).
 *
 * `<fieldset>` + `<legend>` is what makes the group a group for assistive tech.
 * The native control is visually replaced by a drawn dot but still present and
 * focusable, so keyboard, click-the-label and screen-reader behaviour are the
 * browser's, not ours.
 */
function RadioField({
  legend,
  hint,
  name,
  options,
  register,
  disabled,
  error,
}: {
  legend: string;
  hint: string;
  name: string;
  options: readonly { value: string; label: string; hint: string }[];
  register: UseFormRegisterReturn;
  disabled?: boolean;
  error?: string;
}) {
  const hintId = `${name}-hint`;
  const errorId = `${name}-error`;

  return (
    <fieldset
      className="flex flex-col gap-2.5"
      aria-describedby={error ? `${errorId} ${hintId}` : hintId}
      aria-invalid={Boolean(error)}
    >
      {/* <legend> must stay the first child of <fieldset>: wrapping it in a div
          to sit it beside the hint would silently drop the group's name. */}
      <legend className="text-base font-semibold">{legend}</legend>
      <p id={hintId} className="text-muted-foreground text-xs leading-relaxed">
        {hint}
      </p>

      <div className="grid gap-3 @xl:grid-cols-2">
        {options.map((option) => (
          <label
            key={option.value}
            htmlFor={`${name}-${option.value}`}
            className={cn(
              "bg-card border-border has-checked:border-primary has-checked:bg-accent/20 has-checked:ring-primary flex cursor-pointer items-start gap-3 rounded-xl border p-4 transition-colors has-checked:ring-1",
              "has-focus-visible:ring-ring/50 has-focus-visible:ring-3",
            )}
          >
            <input
              {...register}
              id={`${name}-${option.value}`}
              type="radio"
              value={option.value}
              disabled={disabled}
              className="peer sr-only"
            />
            <span
              aria-hidden="true"
              className="border-input peer-checked:border-primary mt-0.5 size-4 shrink-0 rounded-full border-2 bg-transparent transition-colors peer-checked:bg-primary"
            />
            <span className="flex min-w-0 flex-col gap-1">
              <span className="text-sm font-semibold">{option.label}</span>
              <span className="text-muted-foreground text-xs leading-relaxed">{option.hint}</span>
            </span>
          </label>
        ))}
      </div>

      {error ? (
        <p id={errorId} role="alert" className="text-destructive text-xs">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}

function ComposeResultSkeleton() {
  return (
    <div aria-hidden="true" className="flex flex-col gap-4 motion-safe:animate-pulse">
      <div className="grid gap-4 @3xl:grid-cols-[1.15fr_1fr]">
        <div className="bg-card border-border h-52 rounded-xl border" />
        <div className="bg-muted h-52 rounded-xl" />
      </div>
      <div className="bg-card border-border grid grid-cols-2 gap-2.5 rounded-xl border p-5 sm:grid-cols-5">
        <div className="bg-media-empty-cover col-span-2 row-span-2 aspect-square rounded-xl" />
        {[0, 1, 2, 3, 4, 5].map((cell) => (
          <div key={cell} className="bg-media-empty aspect-square rounded-xl" />
        ))}
      </div>
    </div>
  );
}
