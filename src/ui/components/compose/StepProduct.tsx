"use client";

import { useId } from "react";
import { useWatch, type UseFormRegisterReturn } from "react-hook-form";

import { ApiErrorNotice } from "@/ui/components/feedback/ApiErrorNotice";
import { EmptyState } from "@/ui/components/feedback/EmptyState";
import { MediaGrid } from "@/ui/components/compose/MediaGrid";
import { UploadPanel } from "@/ui/components/compose/UploadPanel";
import { VideoSpecCard } from "@/ui/components/compose/VideoSpecCard";
import { Badge } from "@/ui/components/ui/badge";
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
 * whitelisted columns, and everything about stock sits in a SEPARATE, clearly
 * labelled internal block. A blocked code (hết hàng / thiếu ảnh) is an error
 * state — the wizard offers no way forward from it.
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
    <div className="space-y-6">
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void wizard.submitProductStep();
        }}
        className="space-y-4"
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            id={`${fieldId}-tenant`}
            label="Mã đơn vị (tenant)"
            hint="Dạng UUID. Đơn vị mẫu đã được điền sẵn."
            error={errors.tenantId?.message}
          >
            {(props) => (
              <Input
                {...form.register("tenantId")}
                {...props}
                autoComplete="off"
                spellCheck={false}
                className="font-mono"
              />
            )}
          </Field>

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
          <Button type="submit" size="lg" disabled={compose.isPending}>
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
        <p role="status" className="border-warning/40 bg-warning/10 text-warning-foreground rounded-lg border px-3 py-2 text-sm">
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
          onContinue={() => wizard.goToStep("caption")}
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
  onContinue,
}: {
  composed: ComposeResponse;
  /** Publish order, which this step lets the operator rearrange. */
  album: readonly ComposeResponse["media"][number][];
  onReorder: (next: ComposeResponse["media"][number][]) => void;
  disabled: boolean;
  onContinue: () => void;
}) {
  return (
    <div className="space-y-6">
      <ContentFacts composed={composed} />
      <InternalOperatorInfo composed={composed} />
      {composed.video ? (
        <VideoSpecCard video={composed.video} clip={composed.media[0]} />
      ) : null}
      <MediaGrid media={album} onReorder={onReorder} disabled={disabled} />

      <div className="flex flex-wrap gap-2 border-t pt-4">
        <Button type="button" size="lg" onClick={onContinue}>
          Tiếp tục: duyệt caption
        </Button>
      </div>
    </div>
  );
}

/** The ONLY product fields allowed near a caption (brief §2.2). */
function ContentFacts({ composed }: { composed: ComposeResponse }) {
  const { content } = composed;

  return (
    <section aria-labelledby="content-heading" className="bg-card space-y-3 rounded-xl border p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="content-heading" className="text-base font-semibold">
          Thông tin đưa vào caption
        </h3>
        <Badge tone="info">{content.code}</Badge>
      </div>
      <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
        <Fact label="Tên sản phẩm" value={content.name} />
        <Fact label="Chủng loại" value={content.category} />
        <Fact label="Mùa vụ" value={content.season} />
        <Fact label="Mô tả" value={content.description} className="sm:col-span-2" />
      </dl>
      <p className="text-muted-foreground text-xs">
        Chỉ bốn trường trên được gửi cho AI và xuất hiện trong caption. Giá, tồn kho và ghi chú sản
        xuất không bao giờ đi kèm.
      </p>
    </section>
  );
}

/**
 * Internal operator notes — stock, warnings, colours found on Drive.
 * Deliberately OUTSIDE the caption block and never copied into a caption
 * (CLAUDE.md business rule 2 + brief §3).
 */
function InternalOperatorInfo({ composed }: { composed: ComposeResponse }) {
  const { inventory, warnings, availableColors } = composed;
  if (!inventory && warnings.length === 0 && availableColors.length === 0) return null;

  return (
    <section
      aria-labelledby="internal-heading"
      className="border-warning/30 bg-warning/5 space-y-3 rounded-xl border p-5"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="internal-heading" className="text-base font-semibold">
          Thông tin nội bộ — không đưa vào caption
        </h3>
        {inventory ? (
          <Badge tone={inventory.status === "in_stock" ? "success" : "warning"}>
            {INVENTORY_STATUS_LABELS[inventory.status]}
            {inventory.stock !== null ? ` · tồn ${inventory.stock}` : ""}
          </Badge>
        ) : null}
      </div>

      {availableColors.length > 0 ? (
        <p className="text-sm">
          <span className="text-muted-foreground">Màu có ảnh trên Drive:</span>{" "}
          {availableColors.join(", ")}
        </p>
      ) : null}

      {warnings.length > 0 ? (
        <ul className="list-disc space-y-1 pl-5 text-sm">
          {warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      ) : (
        <p className="text-muted-foreground text-sm">Không có cảnh báo nào cho mã này.</p>
      )}
    </section>
  );
}

function Fact({
  label,
  value,
  className,
}: {
  label: string;
  value: string | null;
  className?: string;
}) {
  return (
    <div className={className}>
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className={value ? "" : "text-muted-foreground italic"}>
        {value && value.trim().length > 0 ? value : "(trống trên Sheet)"}
      </dd>
    </div>
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
    <div className="space-y-1.5">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      {children({
        id,
        "aria-invalid": Boolean(error),
        "aria-describedby": error ? `${errorId} ${hintId}` : hintId,
      })}
      <p id={hintId} className="text-muted-foreground text-xs">
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
 * `<fieldset>` + `<legend>` is what makes the group a group for assistive tech;
 * each option carries its own hint, wired through `aria-describedby`.
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
      className="space-y-2"
      aria-describedby={error ? `${errorId} ${hintId}` : hintId}
      aria-invalid={Boolean(error)}
    >
      <legend className="text-sm font-medium">{legend}</legend>
      <p id={hintId} className="text-muted-foreground text-xs">
        {hint}
      </p>

      <div className="grid gap-2 sm:grid-cols-2">
        {options.map((option) => (
          <label
            key={option.value}
            htmlFor={`${name}-${option.value}`}
            className="bg-card hover:bg-muted/40 has-checked:border-primary flex cursor-pointer items-start gap-2 rounded-lg border p-3 text-sm"
          >
            <input
              {...register}
              id={`${name}-${option.value}`}
              type="radio"
              value={option.value}
              disabled={disabled}
              className="accent-primary mt-0.5 size-4"
            />
            <span>
              {option.label}
              <span className="text-muted-foreground block text-xs">{option.hint}</span>
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
    <div aria-hidden="true" className="space-y-4 motion-safe:animate-pulse">
      <div className="bg-card space-y-3 rounded-xl border p-5">
        <div className="bg-muted h-5 w-56 rounded" />
        <div className="bg-muted h-4 w-full max-w-md rounded" />
        <div className="bg-muted h-4 w-2/3 rounded" />
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {[0, 1, 2, 3, 4, 5].map((cell) => (
          <div key={cell} className="bg-card h-[86px] rounded-lg border p-3">
            <div className="bg-muted h-4 w-24 rounded" />
            <div className="bg-muted mt-2 h-3 w-full rounded" />
          </div>
        ))}
      </div>
    </div>
  );
}
