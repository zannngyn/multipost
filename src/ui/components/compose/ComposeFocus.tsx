"use client";

import { useCallback, useId, useState } from "react";
import { useWatch } from "react-hook-form";

import { cn } from "@/shared/utils";
import { CaptionBlock } from "@/ui/components/compose/CaptionBlock";
import { activeCaptionChannel } from "@/ui/components/compose/caption-targets";
import { ChannelChoice } from "@/ui/components/compose/ChannelChoice";
import { ChannelPickerDialog } from "@/ui/components/compose/ChannelPickerDialog";
import { publishableChannels } from "@/ui/components/compose/channel-picker";
import { ColorChips } from "@/ui/components/compose/ColorChips";
import { describeAction } from "@/ui/components/compose/compose-action";
import { ComposeActionBar } from "@/ui/components/compose/ComposeActionBar";
import {
  COMPOSE_CARD_SHADOW,
  COMPOSE_PALETTE,
  COMPOSE_RULE,
} from "@/ui/components/compose/compose-theme";
import { DraftStatusBar } from "@/ui/components/compose/DraftStatusBar";
import { FacebookPreview } from "@/ui/components/compose/FacebookPreview";
import { PhotoStrip } from "@/ui/components/compose/PhotoStrip";
import { ProductPicker } from "@/ui/components/compose/ProductPicker";
import { ResolvedProductLine } from "@/ui/components/compose/ResolvedProductLine";
import { SegmentedField } from "@/ui/components/compose/SegmentedField";
import { UploadPanel } from "@/ui/components/compose/UploadPanel";
import { VideoSpecCard } from "@/ui/components/compose/VideoSpecCard";
import { ApiErrorNotice } from "@/ui/components/feedback/ApiErrorNotice";
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

/**
 * "Soạn bài" — ONE screen (design: `templates 2/compose-focus/ComposeFocus.dc.html`).
 *
 * The whole post lives on one card: type a code, and the colours, the album,
 * the caption and the channels appear beneath it, with the Facebook preview
 * pinned beside them the entire time. There is no stepper, no "Tiếp / Quay
 * lại", and no step in the URL — the operator never has to hold in their head
 * which screen they are on.
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
 * Palette: `compose-theme.ts`, the one place a hex value exists on this screen.
 */
export function ComposeFocus() {
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
    async (requestedColor: string) => {
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
        return;
      }

      if (outcome.reason === "failed" && key.length > 0) {
        setRefusedColors((current) => ({
          ...current,
          [key]:
            outcome.error?.userMessage ??
            "Màu này chưa lấy được ảnh. Xem lý do ngay bên dưới ô mã.",
        }));
      }
    },
    [wizard],
  );

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

  const action = describeAction({
    readOnlyReason,
    hasChannels: publishableChannels(channels.data?.channels ?? []).length > 0,
    hasComposed: Boolean(composed),
    // NAMED, not counted: "Camilla chưa có caption" is actionable, "1 kênh
    // thiếu caption" sends the operator hunting through tabs.
    missingCaptionChannels: publish.missingCaptionIds.map((id) =>
      channelName(channels.data?.channels, id),
    ),
    channels: publish.selectedIds.length,
    canSubmit: publish.canSubmit,
  });

  return (
    // The palette wrapper. Everything below reads its colours from here, so the
    // screen can be re-skinned in one file (compose-theme.ts).
    <div
      style={COMPOSE_PALETTE}
      className="h-full min-h-0 overflow-y-auto bg-[var(--background)] text-[var(--foreground)]"
    >
      <div className="@container mx-auto flex w-full max-w-[1440px] flex-col gap-4 p-5">
        <header className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <h1 className="text-xl font-semibold tracking-tight">Soạn bài</h1>
          <p className="text-[13px] text-[var(--muted-foreground)]">
            Nhập mã sản phẩm — hệ thống tra Sheet, kiểm tồn kho rồi gom ảnh. Bài chỉ lên khi bạn
            bấm đăng.
          </p>
          <span className="flex-1" />
          <div className="min-w-70">
            <DraftStatusBar draft={draft} />
          </div>
        </header>

        <div className="flex flex-col items-start gap-6 @5xl:flex-row">
          {/* ---------------------------------------------------------------
              Left card — the post being made (template lines 37–132).
              --------------------------------------------------------------- */}
          <section
            aria-label="Nội dung bài đăng"
            className={cn(
              "flex w-full min-w-0 flex-col gap-4.5 rounded-[var(--compose-radius-card)] bg-[var(--card)] p-6 @5xl:w-190 @5xl:shrink-0",
              COMPOSE_CARD_SHADOW,
            )}
          >
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
                disabled={compose.isPending}
                invalid={Boolean(errors.productCode)}
                describedBy={errors.productCode ? `${codeErrorId} ${codeHintId}` : codeHintId}
                placeholder="Nhập mã hoặc tên sản phẩm…"
                inputClassName="h-13 rounded-[var(--compose-radius-control)] border-0 bg-[var(--card)] px-4.5 text-lg font-medium shadow-[inset_0_0_0_1.5px_var(--input)]"
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
                    form.setFocus("productCode");
                  }}
                />
              ) : (
                <div className="flex flex-wrap items-center gap-3">
                  <p id={codeHintId} className="text-[13px] text-[var(--muted-foreground)]">
                    Gõ vài ký tự đầu của mã rồi chọn trong danh sách. Mã đã hết hàng không đăng
                    được — danh sách nói rõ ngay khi bạn chọn.
                  </p>
                  <span className="flex-1" />
                  {/* Not in the mock, which only draws the resolved state: the
                      mock's field is submitted by picking a row. A code typed
                      in full still needs a visible way to run the lookup, so
                      the button exists exactly while nothing is resolved. */}
                  <button
                    type="submit"
                    disabled={compose.isPending}
                    className="focus-visible:ring-ring h-9.5 shrink-0 cursor-pointer rounded-[10px] bg-[var(--card)] px-4 text-[13px] font-medium shadow-[inset_0_0_0_1px_var(--compose-hairline-strong)] outline-none focus-visible:ring-3 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {compose.isPending ? "Đang tra…" : "Tra dữ liệu"}
                  </button>
                </div>
              )}

              <p className="sr-only" role="status" aria-live="polite">
                {compose.isPending ? "Đang tra dữ liệu sản phẩm" : ""}
              </p>
            </form>

            {compose.isError ? (
              <ApiErrorNotice error={compose.error} onRetry={() => void lookUp(color)} />
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
            {composed && composed.warnings.length > 0 ? (
              <ul aria-label="Cảnh báo nội bộ" className="flex flex-col gap-1.5">
                {composed.warnings.map((warning) => (
                  <li
                    key={warning}
                    className="rounded-lg bg-[var(--warning)]/15 px-3 py-2 text-xs leading-relaxed text-[var(--warning-foreground)]"
                  >
                    {warning}
                  </li>
                ))}
              </ul>
            ) : null}

            <span aria-hidden="true" className={COMPOSE_RULE} />

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
                  rejected={wizard.uploadRejections}
                  uploadedCount={wizard.uploadedCount}
                  disabled={compose.isPending}
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

                <span aria-hidden="true" className={COMPOSE_RULE} />

                {/* KÊNH ĐĂNG BEFORE CAPTION (PM, 21/08/2026): a caption is
                    written per Fanpage, so "đăng lên đâu" has to be answered
                    before there is anything to write. The caption block below
                    says so in words when nothing is ticked yet. */}
                <ChannelChoice
                  publish={publish}
                  onOpenPicker={() => setPickerOpen(true)}
                  readOnlyReason={readOnlyReason}
                />

                <span aria-hidden="true" className={COMPOSE_RULE} />

                <CaptionBlock
                  wizard={wizard}
                  publish={publish}
                  activeChannelId={activeChannelId}
                  onActiveChannelChange={setActiveChannelId}
                  onOpenPicker={() => setPickerOpen(true)}
                  readOnlyReason={readOnlyReason}
                />
              </>
            ) : compose.isError ? null : (
              <EmptyLookup mediaKind={mediaKind} restoring={draft.isRestoring} />
            )}

            <span aria-hidden="true" className={COMPOSE_RULE} />

            {publish.formError ? (
              <p role="alert" className="text-[13px] text-[var(--destructive)]">
                {publish.formError}
              </p>
            ) : null}

            {publish.createBatch.isError ? (
              <ApiErrorNotice error={publish.createBatch.error} />
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
            className="pointer-events-auto rounded-xl bg-[var(--compose-ink)] px-5 py-3 text-[13px] text-[var(--card)] shadow-[0_14px_30px_rgba(34,31,28,0.28)]"
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

/** The form field holding the shared caption. Phase 1 publishes to Facebook. */
const PREVIEW_CHANNEL = "facebook";

/** A Page's name, or its id when the list has not arrived (or it is gone). */
function channelName(channels: readonly Channel[] | undefined, channelId: string): string {
  const found = channels?.find((item) => item.channelId === channelId);
  const name = found?.name?.trim();
  return name && name.length > 0 ? name : channelId;
}

/** Stand-in until a channel is ticked — naming a Page nobody chose would lie. */
const PREVIEW_PAGE_NAME = "Trang Facebook của bạn";

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
    hint: "Một clip, đăng lên dòng thời gian của Trang. Tỷ lệ 9:16 đến 16:9.",
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
    <div className="flex flex-col gap-1.5 rounded-[var(--compose-radius-block)] bg-[var(--compose-well)] px-4 py-8 text-center shadow-[inset_0_0_0_1px_var(--compose-hairline)]">
      <p className="text-sm font-medium">
        {restoring ? "Đang mở lại nháp…" : "Chưa tra mã nào"}
      </p>
      <p className="mx-auto max-w-100 text-xs leading-relaxed text-[var(--muted-foreground)]">
        {restoring
          ? "Nháp đang được tra lại từ đầu: Sheet và tồn kho được kiểm lại chứ không dùng kết quả cũ."
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
            className="h-11.5 w-32 rounded-[var(--compose-radius-control)] bg-[var(--compose-track)]"
          />
        ))}
      </div>
      <div className="flex gap-3">
        {[0, 1, 2, 3, 4].map((tile) => (
          <div
            key={tile}
            className="h-32 w-24 rounded-[var(--compose-radius-tile)] bg-[var(--media-empty)]"
          />
        ))}
      </div>
      <div className="h-64 rounded-[var(--compose-radius-block)] bg-[var(--compose-well)]" />
    </div>
  );
}
