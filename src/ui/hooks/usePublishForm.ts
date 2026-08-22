"use client";

import { useRouter } from "next/navigation";
import { useCallback, useMemo, useState } from "react";

import { useChannelGroups } from "@/ui/hooks/useChannelGroups";
import { useCreatePostBatch } from "@/ui/hooks/usePostBatch";
import { useScheduleChoice } from "@/ui/hooks/useScheduleChoice";
import type { ComposeWizard } from "@/ui/hooks/useComposeWizard";
import {
  missingCaptionChannelIds,
  resolveCaption,
  seedOverridesFromBase,
  type CaptionSources,
} from "@/ui/components/compose/caption-targets";
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

  const groups = useChannelGroups();
  const createBatch = useCreatePostBatch();
  const schedule = useScheduleChoice();

  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set<string>());
  /**
   * Per-channel is the DEFAULT (brief §7.2 + validator D1): several Pages
   * carrying the identical caption is what a platform reads as spam, and the
   * server measures it. Sharing one caption is the shortcut an operator opts
   * into, not the shape the screen starts in.
   *
   * Until a tab is actually edited nothing changes for a one-channel post:
   * `resolveCaption` falls back to the shared caption for a channel with no
   * text of its own.
   */
  const [shareCaption, setShareCaption] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  /**
   * Per-channel edits, kept OUT of the wizard form on purpose: a channel id is
   * free text and react-hook-form reads `a.b` as a nested path, so an id with a
   * dot would silently write to the wrong place. Absent key = "same as the
   * approved caption".
   */
  const [captionOverrides, setCaptionOverrides] = useState<Record<string, string>>({});

  const captions = wizard.captionValues ?? {};
  const baseCaption = (captions[BASE_CHANNEL_ID] ?? "").trim();

  const selectedIds = useMemo(() => [...selected], [selected]);
  const groupItems = groups.data?.groups ?? [];

  /**
   * The two halves of "one caption per channel", in one object so the editor
   * and the payload cannot disagree about what a channel is going to publish
   * (`caption-targets.ts` owns the rule; this hook owns the state).
   */
  const captionSources: CaptionSources = useMemo(
    () => ({ shareCaption, base: baseCaption, overrides: captionOverrides }),
    [shareCaption, baseCaption, captionOverrides],
  );

  const captionFor = useCallback(
    (channelId: string): string => resolveCaption(captionSources, channelId).trim(),
    [captionSources],
  );

  /** Ticked channels that would go out with no text at all — publish blockers. */
  const missingCaptionIds = useMemo(
    () => missingCaptionChannelIds(captionSources, selectedIds),
    [captionSources, selectedIds],
  );

  const toggleChannel = useCallback((channelId: string, checked: boolean) => {
    setFormError(null);
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(channelId);
      else next.delete(channelId);
      return next;
    });
  }, []);

  /**
   * Replaces the whole selection in one go — what the channel modal applies
   * when "Xong" is pressed.
   *
   * A replace, not a merge: the modal shows the complete picture while it is
   * open, so what it hands back IS the answer. Merging would resurrect a
   * channel the operator just unticked in there.
   */
  const setSelectedChannels = useCallback((channelIds: readonly string[]) => {
    setFormError(null);
    setSelected(new Set(channelIds));
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

  const setCaptionOverride = useCallback((channelId: string, text: string) => {
    setCaptionOverrides((current) => ({ ...current, [channelId]: text }));
  }, []);

  /**
   * Switches between "dùng chung" and per-channel.
   *
   * Turning it OFF seeds each ticked channel from the caption on screen — five
   * empty boxes is not a starting point. Turning it ON drops the per-channel
   * copies, and the CALLER is the one that asked the operator first: this hook
   * never destroys typed text on its own.
   */
  const setShare = useCallback(
    (next: boolean, options?: { seedFrom?: readonly string[] }) => {
      setFormError(null);
      setShareCaption(next);
      if (next) {
        setCaptionOverrides({});
        return;
      }
      const seedIds = options?.seedFrom;
      if (!seedIds || seedIds.length === 0) return;
      setCaptionOverrides((current) => seedOverridesFromBase(current, seedIds, baseCaption));
    },
    [baseCaption],
  );

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
   */
  const restore = useCallback(
    (draft: {
      selectedChannelIds: readonly string[];
      shareCaption: boolean;
      captionOverrides: Record<string, string>;
      schedule: { mode: "now" | "scheduled"; value: string };
    }) => {
      setFormError(null);
      setSelected(new Set(draft.selectedChannelIds));
      setShareCaption(draft.shareCaption);
      setCaptionOverrides({ ...draft.captionOverrides });
      schedule.restore(draft.schedule);
    },
    [schedule],
  );

  /** Back to an untouched publish form — used by "Xoá nháp". */
  const reset = useCallback(() => {
    setFormError(null);
    setSelected(new Set<string>());
    setShareCaption(false);
    setCaptionOverrides({});
    schedule.reset();
    createBatch.reset();
  }, [createBatch, schedule]);

  const submit = useCallback(() => {
    setFormError(null);
    createBatch.reset();

    // --- Edge cases first: nothing leaves the browser until they all pass ---
    if (!composed) {
      setFormError("Chưa có dữ liệu bài đăng. Hãy tra mã sản phẩm trước.");
      return;
    }
    if (selectedIds.length === 0) {
      setFormError("Chọn ít nhất một kênh để đăng.");
      return;
    }
    // NOT "the shared caption is empty": with per-channel captions a channel can
    // carry its own text while the shared box is blank. The real question is
    // whether every TICKED channel resolves to something, and it is asked below
    // once, by the same rule the editor shows.

    // Format follows what was COMPOSED, never the radio on step 1: the album on
    // screen is the one being approved (business rule 6 — no surprise content).
    const format = postFormatForVideo(composed.video);
    // Measured on the album that will actually be sent, not on the compose
    // response — those are the same length today, and this guard should keep
    // holding if that ever stops being true.
    if (composed.video && wizard.album.length !== 1) {
      setFormError("Bài video chỉ đăng được đúng một clip. Hãy soạn lại bài.");
      return;
    }

    // EVERY ticked channel gets an entry, in both modes: "dùng chung" copies the
    // approved caption to each one, per-channel sends each channel's own text
    // (falling back to the shared one where nothing was written for it). The
    // server refuses a missing channel by name, so a gap here is never silent.
    const captionByChannel: Record<string, string> = {};
    for (const channelId of selectedIds) {
      captionByChannel[channelId] = captionFor(channelId);
    }
    if (missingCaptionIds.length > 0) {
      setFormError(`Các kênh sau chưa có caption: ${missingCaptionIds.join(", ")}.`);
      return;
    }
    // The schedule is validated LAST, against the clock at this instant: the
    // panel may have been open for an hour. Its own message lands on the field.
    const resolved = schedule.resolve();
    if (!resolved.ok) return;

    createBatch.mutate(
      {
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
    captionFor,
    composed,
    createBatch,
    missingCaptionIds,
    router,
    schedule,
    selectedIds,
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
    setSelectedChannels,
    toggleChannel,
    toggleGroup,
    shareCaption,
    setShareCaption: setShare,
    captionOverrides,
    setCaptionOverride,
    baseCaption,
    /** Shared + per-channel captions, as  reads them. */
    captionSources,
    captionFor,
    /** Ticked channels with no text at all — named by the action bar. */
    missingCaptionIds,
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
    /**
     * A preset group is NOT part of this any more (ComposeFocus, 20/08/2026):
     * channels are ticked one by one in the picker modal, which lists the
     * tenant's Pages straight from `/api/channels`. Groups became the shortcut
     * they were always meant to be, so a tenant that never made one could no
     * longer publish at all — that was the bug this line used to encode.
     */
    canSubmit:
      Boolean(composed) &&
      selectedIds.length > 0 &&
      missingCaptionIds.length === 0 &&
      !createBatch.isPending,
    isPending: createBatch.isPending,
    /**
     * Wording of the one black action at the bottom of the card (ComposeFocus
     * template line 129). "Đăng luôn" is literal: pressing it creates the lô and
     * the worker publishes straight away. Nothing auto-publishes — the label
     * describes what THIS press does, which is the whole point of the screen.
     */
    submitLabel: createBatch.isPending
      ? "Đang tạo lô…"
      : schedule.mode === "scheduled"
        ? "Hẹn lịch đăng"
        : "Đăng luôn",
  };
}

export type PublishForm = ReturnType<typeof usePublishForm>;
