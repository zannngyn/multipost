"use client";

import { useRouter } from "next/navigation";
import { useCallback, useMemo, useState } from "react";

import {
  captionForChannel,
  EMPTY_OWNED_CAPTIONS,
  ownedCaptionText,
  withCaptionOverride,
  type OwnedCaptionText,
} from "@/ui/components/compose/compose-draft";
import { useChannelGroups } from "@/ui/hooks/useChannelGroups";
import { useCreatePostBatch } from "@/ui/hooks/usePostBatch";
import { useScheduleChoice } from "@/ui/hooks/useScheduleChoice";
import type { ComposeWizard } from "@/ui/hooks/useComposeWizard";
import { COMPOSE_CHANNELS, postFormatForVideo } from "@/ui/schemas/compose.schema";

/**
 * Logic layer of step 3's publish action (docs/07 §4.1).
 *
 * It lives in a hook rather than inside `<PublishPanel>` because the fields and
 * the button that fires them are no longer in the same box: the panel renders
 * the channel picker, the per-channel captions and the schedule, while the
 * wizard footer renders the primary "Tạo lô đăng" action. One hook instance,
 * owned by `<ComposeWizard>`, keeps them looking at the same state — the
 * alternative (a second copy of the guards behind the footer button) is how two
 * buttons start disagreeing about whether a post may go out.
 *
 * What this hook is NOT allowed to do (business rules, unchanged from the panel
 * it was extracted from):
 *  - it never reads stock, price or production notes (rule 2);
 *  - it never decides anything about stock — the server re-checks when the batch
 *    is created AND again right before the Graph call (rule 3);
 *  - it sends ASSETS, never image URLs: the signed public URL is minted
 *    server-side (E3.6), so nothing here can forge or leak one.
 */

const BASE_CHANNEL_ID = COMPOSE_CHANNELS[0].id;

export function usePublishForm(wizard: ComposeWizard) {
  const router = useRouter();
  const { composed } = wizard;
  const tenantId = composed?.tenantId ?? "";

  const groups = useChannelGroups(tenantId);
  const createBatch = useCreatePostBatch();
  const schedule = useScheduleChoice();

  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set<string>());
  const [shareCaption, setShareCaption] = useState(true);
  const [formError, setFormError] = useState<string | null>(null);
  /**
   * Per-channel edits, kept OUT of the wizard form on purpose: a channel id is
   * free text and react-hook-form reads `a.b` as a nested path, so an id with a
   * dot would silently write to the wrong place. Absent key = "same as the
   * approved caption".
   *
   * Stored WITH the compose key they were typed under. Without that owner they
   * were the third caption leak: the wizard cleared `form.captions` when the
   * operator looked up another code, this state was never told, and with "dùng
   * chung caption" off the old product's text went out under the new one.
   */
  const [overrideState, setOverrideState] = useState<OwnedCaptionText>(EMPTY_OWNED_CAPTIONS);

  const captions = wizard.captionValues ?? {};
  const baseCaption = (captions[BASE_CHANNEL_ID] ?? "").trim();
  /** Identity the captions on screen belong to — the one the wizard maintains. */
  const captionsKey = wizard.captionsKey;

  /**
   * Overrides that survive the ownership check, recomputed on every render from
   * the key the wizard reports. One rule, one place: every path that changes
   * what is composed (re-lookup, refused compose, draft restore, reset) goes
   * through this without having to remember to.
   */
  const ownedOverrides = ownedCaptionText(overrideState, captionsKey);
  // Adjusting state DURING render when the value it derives from changed is
  // React's own answer here — an effect would paint one frame of another
  // product's caption first. `ownedCaptionText` returns the same object when
  // nothing changed, which is what stops this from looping.
  if (ownedOverrides !== overrideState) setOverrideState(ownedOverrides);

  const selectedIds = useMemo(() => [...selected], [selected]);
  const groupItems = groups.data?.groups ?? [];

  const toggleChannel = useCallback((channelId: string, checked: boolean) => {
    setFormError(null);
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(channelId);
      else next.delete(channelId);
      return next;
    });
  }, []);

  const toggleGroup = useCallback((channelIds: readonly string[], checked: boolean) => {
    setFormError(null);
    setSelected((current) => {
      const next = new Set(current);
      for (const channelId of channelIds) {
        if (checked) next.add(channelId);
        else next.delete(channelId);
      }
      return next;
    });
  }, []);

  const setCaptionOverride = useCallback(
    (channelId: string, text: string) => {
      setOverrideState((current) => withCaptionOverride(current, captionsKey, channelId, text));
    },
    [captionsKey],
  );

  const setShare = useCallback((next: boolean) => {
    setFormError(null);
    setShareCaption(next);
  }, []);

  /**
   * E10 — puts the publish half of a stored draft back on screen.
   *
   * The schedule goes through `schedule.restore`, which re-judges the saved wall
   * time against the clock RIGHT NOW: an hour that was in the future when the
   * draft was saved may be in the past when it is reopened, and restoring the
   * old verdict would show a stale sentence (or worse, none).
   *
   * Channel ids are restored as they were stored. A channel that has since been
   * removed is not filtered out quietly here — the server refuses it by name
   * when the batch is created, which is the answer that is actually true.
   *
   * The overrides come back WITH the key they were typed under, never as bare
   * text: the restore runs after the wizard has re-composed, so by the time this
   * is called the answer may already be a different product. Handing the owner
   * over is what lets the ownership rule above throw them away instead of
   * publishing them under the new code.
   */
  const restore = useCallback(
    (draft: {
      selectedChannelIds: readonly string[];
      shareCaption: boolean;
      captionOverrides: Record<string, string>;
      /** Compose key the stored overrides belong to; null = they belong to none. */
      captionOverridesOwner: string | null;
      schedule: { mode: "now" | "scheduled"; value: string };
    }) => {
      setFormError(null);
      setSelected(new Set(draft.selectedChannelIds));
      setShareCaption(draft.shareCaption);
      setOverrideState({
        ownerKey: draft.captionOverridesOwner,
        byChannel: { ...draft.captionOverrides },
      });
      schedule.restore(draft.schedule);
    },
    [schedule],
  );

  /** Back to an untouched publish form — used by "Xoá nháp". */
  const reset = useCallback(() => {
    setFormError(null);
    setSelected(new Set<string>());
    setShareCaption(true);
    setOverrideState(EMPTY_OWNED_CAPTIONS);
    schedule.reset();
    createBatch.reset();
  }, [createBatch, schedule]);

  const submit = useCallback(() => {
    setFormError(null);
    createBatch.reset();

    // --- Edge cases first: nothing leaves the browser until they all pass ---
    if (!composed) {
      setFormError("Chưa có dữ liệu bài đăng. Hãy quay lại bước 1 và tra mã sản phẩm.");
      return;
    }
    if (selectedIds.length === 0) {
      setFormError("Chọn ít nhất một kênh để đăng.");
      return;
    }
    if (baseCaption.length === 0) {
      setFormError("Chưa có caption. Quay lại bước 2 để viết hoặc nhập caption.");
      return;
    }

    // Format follows what was COMPOSED, never the radio on step 1: the album on
    // screen is the one being approved (business rule 6 — no surprise content).
    const format = postFormatForVideo(composed.video);
    // Measured on the album that will actually be sent, not on the compose
    // response — those are the same length today, and this guard should keep
    // holding if that ever stops being true.
    if (composed.video && wizard.album.length !== 1) {
      setFormError("Bài video chỉ đăng được đúng một clip. Hãy quay lại bước 1 và soạn lại bài.");
      return;
    }

    const captionByChannel: Record<string, string> = {};
    const missing: string[] = [];
    for (const channelId of selectedIds) {
      // Through `captionForChannel`, never straight out of the override record:
      // that is where an override typed for another product is refused, and this
      // loop is the last place it could still be refused before Facebook.
      const text = captionForChannel({
        channelId,
        baseCaption,
        shareCaption,
        overrides: overrideState,
        currentKey: captionsKey,
      });
      if (text.length === 0) missing.push(channelId);
      else captionByChannel[channelId] = text;
    }
    if (missing.length > 0) {
      setFormError(`Các kênh sau chưa có caption: ${missing.join(", ")}.`);
      return;
    }
    // The schedule is validated LAST, against the clock at this instant: the
    // panel may have been open for an hour. Its own message lands on the field.
    const resolved = schedule.resolve();
    if (!resolved.ok) return;

    createBatch.mutate(
      {
        tenantId: composed.tenantId,
        productCode: composed.content.code,
        color: wizard.form.getValues().color,
        format,
        channelIds: selectedIds,
        captionByChannel,
        scheduledAt: resolved.scheduledAt,
        // Cover first. `composePost` proposes an order and the operator may
        // rearrange it in step 1; `wizard.album` is whichever won.
        media: wizard.album.map((asset) => ({
          driveFileId: asset.driveFileId,
          fileName: asset.fileName,
          kind: asset.kind,
        })),
      },
      {
        onSuccess: (result) => {
          // A scheduled lô has nothing to watch for hours: send the operator to
          // the list of what is coming (where it can still be moved or cancelled)
          // instead of a batch page that would poll an unchanging "chờ đăng".
          // An immediate lô goes to its own URL — the operator can close the tab.
          if (resolved.scheduledAt) router.push("/scheduled");
          else router.push(`/batches/${encodeURIComponent(result.batchId)}`);
        },
      },
    );
  }, [
    baseCaption,
    captionsKey,
    composed,
    createBatch,
    overrideState,
    router,
    schedule,
    selectedIds,
    shareCaption,
    wizard.album,
    wizard.form,
  ]);

  return {
    groups,
    groupItems,
    createBatch,
    schedule,
    selected,
    selectedIds,
    toggleChannel,
    toggleGroup,
    shareCaption,
    setShareCaption: setShare,
    /**
     * Only the overrides that belong to what is composed right now — so the
     * panel cannot display, and the draft cannot store, text left over from
     * another product.
     */
    captionOverrides: ownedOverrides.byChannel,
    setCaptionOverride,
    baseCaption,
    formError,
    submit,
    /** E10 — draft restore / "Xoá nháp". */
    restore,
    reset,
    /**
     * The footer must be able to dim its button without re-deriving the guards.
     * It is a hint, not the gate: `submit` still checks everything and explains
     * what is missing, because a disabled button that says nothing is worse.
     */
    canSubmit:
      Boolean(composed) &&
      groupItems.length > 0 &&
      selectedIds.length > 0 &&
      baseCaption.length > 0 &&
      !createBatch.isPending,
    isPending: createBatch.isPending,
    submitLabel: createBatch.isPending
      ? "Đang tạo lô…"
      : schedule.mode === "scheduled"
        ? "Tạo lô hẹn giờ"
        : "Tạo lô đăng",
  };
}

export type PublishForm = ReturnType<typeof usePublishForm>;
