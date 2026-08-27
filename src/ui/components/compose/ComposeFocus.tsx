"use client";

import { Banner, Button } from "@astryxdesign/core";
import { useRouter } from "next/navigation";
import { useCallback, useId, useMemo, useState, type ReactNode } from "react";
import { useWatch } from "react-hook-form";

import {
  channelLabelIndex,
  channelNameOf,
  channelSentenceName,
} from "@/ui/components/channels/channel-option-labels";
import { CaptionBlock } from "@/ui/components/compose/CaptionBlock";
import { DetectedCodeNotice } from "@/ui/components/compose/DetectedCodeNotice";
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
import { FacebookPreview } from "@/ui/components/compose/FacebookPreview";
import { ManualProductForm } from "@/ui/components/compose/ManualProductForm";
import { PhotoStrip } from "@/ui/components/compose/PhotoStrip";
import { ProductPicker } from "@/ui/components/compose/ProductPicker";
import { ResolvedProductLine } from "@/ui/components/compose/ResolvedProductLine";
import { SegmentedField } from "@/ui/components/compose/SegmentedField";
import { UploadPanel } from "@/ui/components/compose/UploadPanel";
import { VideoSpecCard } from "@/ui/components/compose/VideoSpecCard";
import { ApiErrorNotice } from "@/ui/components/feedback/ApiErrorNotice";
import { SchedulePicker } from "@/ui/components/scheduled/SchedulePicker";
import { Eyebrow } from "@/ui/components/ui/eyebrow";
import { useChannels } from "@/ui/hooks/useChannels";
import { useComposeDraft } from "@/ui/hooks/useComposeDraft";
import { useComposeWizard } from "@/ui/hooks/useComposeWizard";
import { useDelayedFlag } from "@/ui/hooks/useDelayedFlag";
import { usePublishForm } from "@/ui/hooks/usePublishForm";
import { useReadOnlyReason } from "@/ui/hooks/useReadOnlyReason";
import type { Channel } from "@/ui/schemas/channel.schema";
import {
  MEDIA_SOURCES,
  MEDIA_SOURCE_HINTS,
  MEDIA_SOURCE_LABELS,
  type MediaKind,
  type VideoTarget,
} from "@/ui/schemas/compose.schema";
import {
  EMPTY_MANUAL_PRODUCT,
  type ManualProductFormValues,
} from "@/ui/schemas/manual-product.schema";
import { ApiError } from "@/ui/services/api-error";

/**
 * "Soạn bài" — ONE screen.
 *
 * The whole post lives on one card: type a code, and the colours, the album,
 * the caption and the channels appear beneath it, with the Facebook preview
 * pinned beside them the entire time. There is no stepper, no "Tiếp / Quay
 * lại", and no step in the URL — the operator never has to hold in their head
 * which screen they are on.
 *
 * What the card DOES carry is a numbered rail down its left edge (`Step`), four
 * stops in the order the business runs. A card this tall with nothing but blank
 * space between blocks left an operator scrolling with no idea how much was
 * left; the numbers are a map, not a gate — nothing is disabled by them and the
 * order never changes.
 *
 * The one action lives in a sticky tray at the foot of the column, together
 * with the schedule fields and the sentence saying why it is refusing. It is
 * the only place on this screen where "đăng ngay hay hẹn giờ" is answered.
 *
 * The BUSINESS order is untouched (CLAUDE.md rule 1): compose runs the Sheet
 * lookup and the stock gate BEFORE any album or caption exists, the AI is only
 * asked once there is a composed post, and nothing is published until a person
 * presses the one black button. What changed is the presentation, nothing else.
 *
 * Business rule 2, made visible by the layout: every operator-only fact — the
 * stock number, the Drive warnings, the video spec table — sits ABOVE the
 * caption block and outside it, so selecting and copying the caption can never
 * pick one up. The caption block holds the post and nothing but the post.
 *
 * Palette: the app's own semantic tokens (`globals.css`) and nothing else. The
 * bespoke skin this screen used to carry is gone: it re-pointed
 * `--background`, `--primary` and a dozen more on a wrapper, which made compose
 * the one screen in the product that did not change when the design did.
 */
export function ComposeFocus() {
  const router = useRouter();
  const wizard = useComposeWizard();
  const publish = usePublishForm(wizard);
  // Owned here, like `publish`: the draft line, the fields and the action bar
  // must all be looking at the same draft (E10).
  const draft = useComposeDraft(wizard, publish);

  const fieldId = useId();
  /**
   * Support mode is read-only (M3.3, doc 09 §3.5): every write answers 403.
   * The screen disables the writes and SAYS why, rather than offering buttons
   * that can only fail (core-auth-session). Reading — tra mã, xem ảnh, xem
   * trước — stays available, because that is the point of a support session.
   */
  const readOnlyReason = useReadOnlyReason();
  const [pickerOpen, setPickerOpen] = useState(false);
  /**
   * Which channel's caption is being edited and previewed. `null` = the shared
   * caption. Owned HERE because two things read it: the caption tabs and the
   * Facebook preview, which must show the text and the Page of the same tab.
   */
  const [activeChannelId, setActiveChannelId] = useState<string | null>(null);
  /**
   * Colours the last SUCCESSFUL lookup found, and why a colour was refused.
   *
   * Both are kept here rather than derived from `composed`, because a refused
   * colour clears `composed` (the post genuinely no longer exists) — and a chip
   * row that vanishes the moment you press a chip leaves the operator with an
   * error message and no way back to the colour that worked.
   */
  const [lastColors, setLastColors] = useState<readonly string[]>([]);
  const [refusedColors, setRefusedColors] = useState<Record<string, string>>({});
  const [flash, setFlash] = useState<string | null>(null);
  /**
   * Whether the "nhập tay" editor is expanded (onboarding phase 3).
   *
   * Only the EDITOR's visibility lives here. Whether this post is a typed one at
   * all is `composed.productOrigin`, which comes from the server — a screen that
   * derived it from "is the form open" would call a reused typed product a
   * synced one the moment the editor was collapsed.
   */
  const [isManualOpen, setIsManualOpen] = useState(false);

  const { form, compose, composed } = wizard;
  const errors = form.formState.errors;
  const showSkeleton = useDelayedFlag(compose.isPending);

  const mediaKind = useWatch({ control: form.control, name: "mediaKind" }) ?? "image";
  const videoTarget = useWatch({ control: form.control, name: "videoTarget" }) ?? "facebook_video";
  const source = useWatch({ control: form.control, name: "source" }) ?? "drive";
  const productCode = useWatch({ control: form.control, name: "productCode" }) ?? "";
  const color = useWatch({ control: form.control, name: "color" }) ?? "";

  const codeHintId = `${fieldId}-code-hint`;
  const codeErrorId = `${fieldId}-code-error`;

  /**
   * The one action that fetches a product. It remembers which colour was asked
   * for, so a refusal can be pinned on the chip that caused it instead of
   * becoming a banner with no owner.
   */
  const lookUp = useCallback(
    async (requestedColor: string): Promise<boolean> => {
      const key = requestedColor.trim().toLowerCase();
      const outcome = await wizard.submitProductStep();

      if (outcome.ok) {
        setLastColors(outcome.composed.availableColors);
        // The colour worked: drop any stale refusal recorded for it.
        setRefusedColors((current) => {
          if (!(key in current)) return current;
          const next = { ...current };
          delete next[key];
          return next;
        });
        return true;
      }

      if (outcome.reason === "failed" && key.length > 0) {
        setRefusedColors((current) => ({
          ...current,
          [key]:
            outcome.error?.userMessage ??
            "Màu này chưa lấy được ảnh. Xem lý do ngay bên dưới ô mã.",
        }));
      }

      return false;
    },
    [wizard],
  );

  /**
   * "Dùng thông tin này" — onboarding phase 3.
   *
   * The typed values are handed to the wizard FIRST, then the SAME lookup runs:
   * same validation, same request, same stock gate. There is no separate
   * "compose a manual product" path anywhere, which is what makes it impossible
   * for typing a product to become a way round business rule 3.
   *
   * The editor only collapses when the lookup SUCCEEDED. A refusal — hết hàng,
   * mã đã có trong dữ liệu đồng bộ, thiếu ảnh — leaves every field on screen
   * with the reason beside it, because the next thing the operator does is fix
   * one of those fields.
   */
  const submitManualProduct = useCallback(
    async (values: ManualProductFormValues) => {
      wizard.applyManualProduct(form.getValues().productCode, values);
      const composedOk = await lookUp(form.getValues().color ?? "");
      if (composedOk) setIsManualOpen(false);
    },
    [form, lookUp, wizard],
  );

  /** "Bỏ nhập tay" — forget the typed data and go back to a plain lookup. */
  const cancelManualProduct = useCallback(() => {
    setIsManualOpen(false);
    wizard.clearManualProduct();
  }, [wizard]);

  /**
   * The offer is made ONLY for "mã này không có trong dữ liệu sản phẩm". Any
   * other refusal (hết hàng, thiếu ảnh, mất mạng) has its own fix, and offering
   * to retype the product there would send the operator down a road that cannot
   * help them.
   */
  const offersManualProduct =
    ApiError.is(compose.error) && compose.error.code === "PRODUCT_NOT_FOUND";
  /** What the SERVER says this post was built from — not what is on the form. */
  const isManualComposed = composed?.productOrigin === "manual";

  // Same query key as the modal and the summary row: cached, not a second fetch.
  const channels = useChannels();
  const colors = composed?.availableColors ?? lastColors;
  const albumCount = wizard.album.length;
  const isVideo = Boolean(composed?.video);
  /**
   * The preview follows the caption tab: the text of the channel being edited,
   * under the name of that Page. Showing tab A's caption over page B's name is
   * exactly the confusion a per-channel editor has to avoid.
   *
   * It asks `activeCaptionChannel` — the SAME function the editor asks — rather
   * than re-deriving "which tab is open" here. Two copies of that rule is how
   * the editor and the payload came apart in the first place; a requested tab
   * that has since been unticked must resolve identically in both.
   */
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

  /**
   * ONE index for the whole missing-caption list, resolved before the map:
   * `channelNameOf` rebuilds a Map of every channel per call, and naming a list
   * row by row is the O(rows × channels) shape `channelLabelIndex` exists to
   * stop (its own docblock asks callers not to do it).
   */
  const missingCaptionNames = useMemo(() => {
    const index = channelLabelIndex(publish.missingCaptionIds, channels.data?.channels);
    return publish.missingCaptionIds.map((id) => channelSentenceName(id, index));
  }, [publish.missingCaptionIds, channels.data]);

  const action = describeAction({
    readOnlyReason,
    hasChannels: publishableChannels(channels.data?.channels ?? []).length > 0,
    hasComposed: Boolean(composed),
    // NAMED, not counted: "Camilla chưa có caption" is actionable, "1 kênh
    // thiếu caption" sends the operator hunting through tabs.
    missingCaptionChannels: missingCaptionNames,
    channels: publish.selectedIds.length,
    canSubmit: publish.canSubmit,
  });

  return (
    // `relative` is load-bearing: without it the absolutely positioned `sr-only`
    // nodes anchor to the AppShell row instead of this scroll area and stretch
    // the document, adding a phantom second scrollbar.
    <div className="bg-background text-foreground relative h-full min-h-0 overflow-y-auto">
      <div className="@container mx-auto flex w-full max-w-[1440px] flex-col gap-4 p-5">
        <header className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <h1 className="text-xl font-semibold tracking-tight">Soạn bài</h1>
          <p className="text-[13px] text-[var(--muted-foreground)]">
            {/* "dữ liệu sản phẩm", not "Sheet": the catalog can be a Google tab,
                an uploaded CSV, or a product typed on this very screen, and this
                is the first line anybody reads. */}
            Nhập mã sản phẩm — hệ thống tra dữ liệu sản phẩm, kiểm tồn kho rồi gom ảnh. Bài chỉ lên
            khi bạn bấm đăng.
          </p>
          <span className="flex-1" />
          <div className="min-w-70">
            <DraftStatusBar draft={draft} />
          </div>
        </header>

        <div className="flex flex-col items-start gap-6 @5xl:flex-row">
          {/* ---------------------------------------------------------------
              Left card — the post being made, in four numbered stops.
              --------------------------------------------------------------- */}
          <section
            aria-label="Nội dung bài đăng"
            className="border-border bg-card flex w-full min-w-0 flex-col gap-7 rounded-xl border p-6 shadow-sm @5xl:w-190 @5xl:shrink-0"
          >
            <Step n={1} label="Sản phẩm">
            {/* --- The one field that starts a post (38–57) --------------- */}
            <form
              noValidate
              onSubmit={(event) => {
                event.preventDefault();
                void lookUp(color);
              }}
              className="flex flex-col gap-2.5"
            >
              <label htmlFor={`${fieldId}-code`} className="sr-only">
                Mã sản phẩm
              </label>

              <ProductPicker
                id={`${fieldId}-code`}
                register={form.register("productCode")}
                value={productCode}
                onSelectCode={(code) =>
                  form.setValue("productCode", code, { shouldDirty: true, shouldValidate: true })
                }
                onSubmit={() => void lookUp(color)}
                /*
                  The suggestion list is absolutely positioned over the card, so
                  an open one lands on top of the typed-product editor and hides
                  its heading. It would also be talking nonsense there: that
                  editor is only open because this code is NOT in the catalog the
                  list searches.
                */
                suppressSuggestions={isManualOpen}
                disabled={compose.isPending}
                invalid={Boolean(errors.productCode)}
                describedBy={errors.productCode ? `${codeErrorId} ${codeHintId}` : codeHintId}
                placeholder="Nhập mã hoặc tên sản phẩm…"
                inputClassName="h-13 rounded-lg border-0 bg-[var(--card)] px-4.5 text-lg font-medium shadow-[inset_0_0_0_1.5px_var(--input)]"
              />

              {errors.productCode ? (
                <p id={codeErrorId} role="alert" className="text-xs text-[var(--destructive)]">
                  {errors.productCode.message}
                </p>
              ) : null}

              {composed ? (
                <ResolvedProductLine
                  id={codeHintId}
                  composed={composed}
                  albumCount={albumCount}
                  onChangeProduct={() => {
                    form.setValue("productCode", "", { shouldDirty: true });
                    form.setValue("color", "", { shouldDirty: true });
                    setRefusedColors({});
                    // Another product means another product's data: typed values
                    // left behind would travel to the next code and come back as
                    // MANUAL_PRODUCT_CONFLICT about a form nobody meant to reuse.
                    cancelManualProduct();
                    form.setFocus("productCode");
                  }}
                />
              ) : (
                <div className="flex flex-wrap items-center gap-3">
                  <p id={codeHintId} className="text-[13px] text-[var(--muted-foreground)]">
                    Gõ vài ký tự đầu của mã rồi chọn trong danh sách — danh sách chỉ gợi ý mã
                    đăng được. Mã đang vướng vẫn gõ thẳng được, hệ thống sẽ nói rõ lý do.
                  </p>
                  <span className="flex-1" />
                  {/* Not in the mock, which only draws the resolved state: the
                      mock's field is submitted by picking a row. A code typed
                      in full still needs a visible way to run the lookup, so
                      the button exists exactly while nothing is resolved. */}
                  <button
                    type="submit"
                    disabled={compose.isPending}
                    className="focus-visible:ring-ring h-9.5 shrink-0 cursor-pointer rounded-lg bg-[var(--card)] px-4 text-[13px] font-medium shadow-[inset_0_0_0_1px_var(--input)] outline-none focus-visible:ring-3 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {compose.isPending ? "Đang tra…" : "Tra dữ liệu"}
                  </button>
                </div>
              )}

              <p className="sr-only" role="status" aria-live="polite">
                {compose.isPending ? "Đang tra dữ liệu sản phẩm" : ""}
              </p>
            </form>

            {/*
              ONE refusal, ONE place. While the typed-product editor is open it
              owns the message — that is where the operator is working and where
              the fix is — and this notice steps aside rather than printing the
              same sentence twice on the same card.
            */}
            {compose.isError && !isManualOpen ? (
              <ApiErrorNotice
                error={compose.error}
                onRetry={() => void lookUp(color)}
                /*
                  ONBOARDING PHASE 3. The server's own sentence already ends with
                  "…hoặc nhập tay thông tin sản phẩm cho bài này"; this is the
                  button that sentence is talking about, so it belongs on the
                  notice rather than somewhere further down the card.
                */
                extraAction={
                  offersManualProduct ? (
                    <Button
                      variant="secondary"
                      label="Nhập tay thông tin sản phẩm"
                      isDisabled={compose.isPending || Boolean(readOnlyReason)}
                      tooltip={readOnlyReason ?? undefined}
                      onClick={() => setIsManualOpen(true)}
                    />
                  ) : undefined
                }
              />
            ) : null}

            {/*
              The typed-product editor. OUTSIDE the lookup <form> above — HTML
              forbids nesting forms, and a nested one would submit the wrong
              thing. It stays mounted across a refusal so nothing typed is lost.
            */}
            {isManualOpen ? (
              <ManualProductForm
                /*
                  NO `key` here, deliberately, and it took one to learn why: the
                  obvious `key={productCode}` remounts the whole editor on every
                  keystroke in the code box above it — six typed fields gone
                  because somebody fixed a typo in the code. Switching product
                  already resets this form the honest way: "Đổi sản phẩm" closes
                  it (`cancelManualProduct`), so the next open is a fresh mount.
                  The heading below tracks the live code so it never names a
                  product other than the one "Dùng thông tin này" will compose.
                */
                productCode={productCode.trim().toUpperCase()}
                defaultValues={wizard.manualProduct?.values ?? EMPTY_MANUAL_PRODUCT}
                isEditing={isManualComposed}
                isPending={compose.isPending}
                error={compose.isError ? compose.error : null}
                readOnlyReason={readOnlyReason}
                onSubmit={(values) => void submitManualProduct(values)}
                onCancel={cancelManualProduct}
              />
            ) : null}

            {/*
              Collapsed state of the same thing: the post IS built from typed
              data, and the operator must be able to see that without the whole
              form in the way. `status="info"`, not warning — nothing is wrong
              here; it is a fact about where the data came from, and the stock
              gate already ran on it like on any other product.
            */}
            {isManualComposed && !isManualOpen ? (
              <Banner
                status="info"
                title="Sản phẩm này do bạn nhập tay"
                description="Dữ liệu dùng để viết caption không lấy từ bảng dữ liệu đã đồng bộ. Hệ thống vẫn kiểm tồn kho như mọi mã khác."
                endContent={
                  <Button
                    variant="secondary"
                    size="sm"
                    label="Sửa thông tin nhập tay"
                    isDisabled={compose.isPending || Boolean(readOnlyReason)}
                    tooltip={readOnlyReason ?? undefined}
                    onClick={() => setIsManualOpen(true)}
                  />
                }
              />
            ) : null}

            {wizard.captionsCleared ? (
              <p
                role="status"
                className="rounded-xl bg-[var(--warning)]/10 px-3.5 py-2.5 text-[13px] text-[var(--warning-foreground)]"
              >
                Caption của sản phẩm trước đã được xoá vì bạn đổi sang mã/màu khác.
              </p>
            ) : null}

            {/* Operator-only notes. DELIBERATELY here, above and outside the
                caption block: tồn kho và cảnh báo là thông tin nội bộ, không
                bao giờ nằm trong khối caption (business rule 2). */}

            {/* Nobody read the stock NUMBER for this tenant. `inventory.status`
                is still `"in_stock"` in that mode, so this is read from the flag
                — and it is the loudest thing on the step, because the numeric
                half of the two-pass stock gate (business rule 3) is off for
                every code composed and approved below. The sold-out note and the
                row-conflict rule still block, in all three modes; the banner's
                own text draws that line. */}
            {composed && stockLabel(composed.inventory).isSkipped ? (
              <StockCheckSkippedBanner
                reason={composed.inventory?.stockCheckSkippedReason ?? null}
              />
            ) : null}

            {composed && composed.warnings.length > 0 ? (
              <ul aria-label="Cảnh báo nội bộ" className="flex flex-col gap-1.5">
                {composed.warnings.map((warning) => (
                  <li
                    key={warning}
                    className="bg-warning/15 text-warning-foreground rounded-lg px-3 py-2 text-xs leading-relaxed"
                  >
                    {warning}
                  </li>
                ))}
              </ul>
            ) : null}
            </Step>

            <Step n={2} label="Ảnh & màu">
            {/* --- Kiểu bài (59–64) + nguồn ảnh --------------------------- */}
            <div className="flex flex-wrap items-start gap-x-8 gap-y-4">
              <SegmentedField
                legend="Kiểu bài"
                name="postKind"
                value={postKindOf(mediaKind, videoTarget)}
                onValueChange={(next) => {
                  const kind = POST_KINDS.find((entry) => entry.value === next);
                  if (!kind) return;
                  form.setValue("mediaKind", kind.mediaKind, { shouldDirty: true });
                  form.setValue("videoTarget", kind.videoTarget, { shouldDirty: true });
                }}
                options={POST_KINDS.map(({ value, label, hint }) => ({ value, label, hint }))}
                disabled={compose.isPending}
              />

              <SegmentedField
                legend="Nguồn ảnh"
                name="source"
                value={source}
                options={MEDIA_SOURCES.map((value) => ({
                  value,
                  label: MEDIA_SOURCE_LABELS[value],
                  hint: MEDIA_SOURCE_HINTS[value],
                }))}
                register={form.register("source")}
                disabled={compose.isPending || wizard.upload.isPending}
              />
            </div>

            {source === "upload" ? (
              <>
                <UploadPanel
                  queue={wizard.uploadQueue}
                  onQueueChange={wizard.setUploadQueue}
                  onUpload={() => wizard.upload.mutate()}
                  isUploading={wizard.upload.isPending}
                  progress={wizard.uploadProgress}
                  onCancel={wizard.cancelUpload}
                  rejected={wizard.uploadRejections}
                  uploadedCount={wizard.uploadedCount}
                  warnings={wizard.uploadWarnings}
                  disabled={compose.isPending}
                />
                <DetectedCodeNotice
                  verdict={wizard.detection?.verdict ?? null}
                  warnings={wizard.detection?.warnings ?? []}
                  isPending={wizard.detect.isPending || compose.isPending}
                  onAction={(action) => {
                    if (action.kind === "sync") {
                      router.push("/sync");
                      return;
                    }
                    // "use-code" and "pick-code" do the same thing: fill the
                    // code field then look it up. An empty code (the blank
                    // "Nhập mã sản phẩm" button) only moves focus there.
                    wizard.applyDetectedCode(action.code);
                  }}
                />
                {wizard.upload.isError ? (
                  <ApiErrorNotice
                    error={wizard.upload.error}
                    onRetry={() => wizard.upload.mutate()}
                  />
                ) : null}
              </>
            ) : null}

            {/* --- Everything below needs a composed post ------------------ */}
            {compose.isPending ? (
              showSkeleton ? (
                <ComposeSkeleton />
              ) : null
            ) : composed ? (
              <>
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

                <PhotoStrip
                  media={wizard.album}
                  onChange={wizard.setAlbum}
                  disabled={compose.isPending}
                />

                {composed.video ? (
                  <VideoSpecCard video={composed.video} clip={composed.media[0]} />
                ) : null}
              </>
            ) : compose.isError ? null : (
              <EmptyLookup mediaKind={mediaKind} restoring={draft.isRestoring} />
            )}
            </Step>

            {/* KÊNH ĐĂNG BEFORE CAPTION (PM, 21/08/2026): a caption is written
                per Page, so "đăng lên đâu" has to be answered before there is
                anything to write. The caption block below says so in words when
                nothing is ticked yet. The two stops appear together, under the
                same condition the colours and the album do — a composed post. */}
            {!compose.isPending && composed ? (
              <>
                <Step n={3} label="Kênh & lịch">
                  <ChannelChoice publish={publish} onOpenPicker={() => setPickerOpen(true)} />
                </Step>

                <Step n={4} label="Caption">
                  <CaptionBlock
                    wizard={wizard}
                    publish={publish}
                    activeChannelId={activeChannelId}
                    onActiveChannelChange={setActiveChannelId}
                    onOpenPicker={() => setPickerOpen(true)}
                    readOnlyReason={readOnlyReason}
                  />
                </Step>
              </>
            ) : null}

            {/* ---------------------------------------------------------------
                The tray. One action, always reachable: the card is several
                viewports tall on a real post, and a button that scrolled away
                with the bottom of it meant scrolling back past everything to
                publish. It carries what belongs to the press and nothing else —
                the time the post goes out, why the button is refusing, and the
                failure of the last press (a notice further up the card would
                land off screen while the tray stayed visible).

                It is NOT a second schedule control: the fields open here, in
                place, the moment "Hẹn lịch" is pressed, and nowhere else on the
                screen.
                --------------------------------------------------------------- */}
            {/* A plane of its own, not a pane of glass: `bg-background/95` +
                `backdrop-blur` let the rows underneath print through the
                buttons on a phone, where the tray covers a third of the
                screen. Opaque card surface, one hairline to say where the card
                ends and the press begins. */}
            <div className="border-border bg-card sticky bottom-0 z-10 -mx-6 -mb-6 flex flex-col gap-3.5 rounded-b-xl border-t px-6 py-4">
              {publish.formError ? (
                <p role="alert" className="text-destructive text-[13px]">
                  {publish.formError}
                </p>
              ) : null}

              {publish.createBatch.isError ? (
                <ApiErrorNotice error={publish.createBatch.error} />
              ) : null}

              {publish.schedule.mode === "scheduled" ? (
                <SchedulePicker
                  choice={publish.schedule}
                  disabled={publish.isPending || Boolean(readOnlyReason)}
                  disabledReason={readOnlyReason ?? undefined}
                  hideModeChoice
                  scopeNote="Áp dụng cho mọi kênh đã chọn. Bấm “Hẹn lịch” lần nữa để quay lại đăng ngay."
                />
              ) : null}

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
          </section>

          {/* ---------------------------------------------------------------
              Right column — the post as Facebook draws it (133–159).
              --------------------------------------------------------------- */}
          <FacebookPreview
            caption={previewCaption}
            pageName={previewPage}
            media={wizard.album}
            isVideo={isVideo}
            className="@5xl:sticky @5xl:top-5 @5xl:min-w-0 @5xl:flex-1"
          />
        </div>
      </div>

      {/* The design's "Chọn kênh đăng" modal (161–191). Opened from the summary
          row and from the action bar; it applies nothing until "Xong". */}
      <ChannelPickerDialog
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        applied={publish.selected}
        onApply={publish.setSelectedChannels}
        readOnlyReason={readOnlyReason}
      />

      {/* Toast of the template (line 192): the reason a dimmed chip refused to
          be picked. `role="status"`, so it is read without stealing focus. */}
      {flash ? (
        <div className="pointer-events-none fixed inset-x-0 bottom-6 z-50 flex justify-center px-4">
          {/* Dismissed by hand, never on a timer: the reason a colour cannot be
              used is exactly the sentence somebody needs to finish reading. */}
          <p
            role="status"
            className="pointer-events-auto rounded-xl bg-foreground text-background px-5 py-3 text-[13px] shadow-lg"
          >
            {flash}{" "}
            <button
              type="button"
              onClick={() => setFlash(null)}
              className="cursor-pointer font-semibold underline underline-offset-2"
            >
              Đóng
            </button>
          </p>
        </div>
      ) : null}
    </div>
  );
}

/**
 * One numbered stop of the compose card.
 *
 * The number sits in a fixed 2.5rem rail down the left edge, so the four stops
 * read as one column an operator can find their place in, and every block keeps
 * the same left edge whether or not a number is beside it.
 *
 * It is NOT a stepper. Every stop is on screen at once and nothing here gates
 * anything: the numbers name the ORDER THE BUSINESS RUNS IN — tra mã và kiểm
 * tồn, gom ảnh, chọn kênh, viết caption (CLAUDE.md rule 1) — which is the one
 * sequence on this screen that a reader genuinely needs. That is also why the
 * order never changes with the state of the form.
 */
function Step({ n, label, children }: { n: number; label: string; children: ReactNode }) {
  const labelId = useId();

  return (
    <section
      aria-labelledby={labelId}
      className="grid grid-cols-[2.5rem_minmax(0,1fr)] gap-x-2"
    >
      <span
        aria-hidden="true"
        className="border-border text-foreground-subtle flex size-7 items-center justify-center rounded-full border font-mono text-[13px]"
      >
        {n}
      </span>
      <Eyebrow id={labelId} className="self-center">{`Bước ${n} — ${label}`}</Eyebrow>
      <div className="col-start-2 flex flex-col gap-4.5 pt-3">{children}</div>
    </section>
  );
}

/** The form field holding the shared caption. Phase 1 publishes to Facebook. */
const PREVIEW_CHANNEL = "facebook";

/**
 * A Page's name, said the way the whole app says it (spec §3.1). ONE id only —
 * the preview header; a list resolves once with `channelLabelIndex` instead.
 *
 * Delegates rather than re-deriving: the id alone is printed only when there is
 * genuinely no name to print — the channel list has not arrived — and a Page
 * that is off or gone is labelled as such instead of appearing as a bare id in
 * "Camilla chưa có caption".
 */
function channelName(channels: readonly Channel[] | undefined, channelId: string): string {
  return channelNameOf(channelId, channels);
}

/** Stand-in until a channel is ticked — naming a Page nobody chose would lie. */
const PREVIEW_PAGE_NAME = "Page Facebook của bạn";

/**
 * "Kiểu bài" as the design draws it — one track — over the two fields the API
 * actually takes. The mock's fourth option (Story) is not offered: nothing in
 * this system can publish one, and a control that cannot work is worse than a
 * control that is missing.
 */
const POST_KINDS = [
  {
    value: "image",
    label: "Ảnh",
    hint: "Bài ảnh 5–10 tấm, ảnh đầu tiên là ảnh bìa.",
    mediaKind: "image" as MediaKind,
    videoTarget: "facebook_video" as VideoTarget,
  },
  {
    value: "video",
    label: "Video",
    hint: "Một clip, đăng lên dòng thời gian của Page. Tỷ lệ 9:16 đến 16:9.",
    mediaKind: "video" as MediaKind,
    videoTarget: "facebook_video" as VideoTarget,
  },
  {
    value: "reels",
    label: "Reels",
    hint: "Chỉ nhận video dọc 9:16, dài 3–90 giây, tối thiểu 540x960.",
    mediaKind: "video" as MediaKind,
    videoTarget: "facebook_reels" as VideoTarget,
  },
] as const;

function postKindOf(mediaKind: MediaKind, videoTarget: VideoTarget): string {
  if (mediaKind !== "video") return "image";
  return videoTarget === "facebook_reels" ? "reels" : "video";
}


/** Idle: nothing has been looked up yet. Not an error, and not empty data. */
function EmptyLookup({ mediaKind, restoring }: { mediaKind: MediaKind; restoring: boolean }) {
  return (
    <div className="flex flex-col gap-1.5 rounded-lg bg-[var(--muted)] px-4 py-8 text-center shadow-[inset_0_0_0_1px_var(--border)]">
      <p className="text-sm font-medium">
        {restoring ? "Đang mở lại nháp…" : "Chưa tra mã nào"}
      </p>
      <p className="mx-auto max-w-100 text-xs leading-relaxed text-[var(--muted-foreground)]">
        {restoring
          ? "Nháp đang được tra lại từ đầu: dữ liệu sản phẩm và tồn kho được kiểm lại chứ không dùng kết quả cũ."
          : mediaKind === "image"
            ? "Nhập mã sản phẩm ở trên. Hệ thống kiểm tra tồn kho trước, sau đó gom ảnh từ Drive."
            : "Nhập mã sản phẩm ở trên. Hệ thống kiểm tồn kho trước, sau đó lấy clip từ Drive và kiểm thông số theo đích đăng."}
      </p>
    </div>
  );
}

/** Same boxes at the same sizes as the real thing, so nothing jumps (CLS = 0). */
function ComposeSkeleton() {
  return (
    <div aria-hidden="true" className="flex flex-col gap-4.5 motion-safe:animate-pulse">
      <div className="flex gap-2.5">
        {[0, 1, 2].map((chip) => (
          <div
            key={chip}
            className="h-11.5 w-32 rounded-lg bg-[var(--muted)]"
          />
        ))}
      </div>
      <div className="flex gap-3">
        {[0, 1, 2, 3, 4].map((tile) => (
          <div
            key={tile}
            className="h-32 w-24 rounded-md bg-[var(--media-empty)]"
          />
        ))}
      </div>
      <div className="h-64 rounded-lg bg-[var(--muted)]" />
    </div>
  );
}
