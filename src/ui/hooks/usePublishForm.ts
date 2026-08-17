"use client";

import { useRouter } from "next/navigation";
import { useCallback, useMemo, useState } from "react";

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
   */
  const [captionOverrides, setCaptionOverrides] = useState<Record<string, string>>({});

  const captions = wizard.captionValues ?? {};
  const baseCaption = (captions[BASE_CHANNEL_ID] ?? "").trim();

  const selectedIds = useMemo(() => [...selected], [selected]);
  const groupItems = groups.data?.groups ?? [];

  const captionFor = useCallback(
    (channelId: string): string => (captionOverrides[channelId] ?? baseCaption).trim(),
    [captionOverrides, baseCaption],
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

  const setShare = useCallback((next: boolean) => {
    setFormError(null);
    setShareCaption(next);
  }, []);

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
      const text = shareCaption ? baseCaption : captionFor(channelId);
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
    captionFor,
    composed,
    createBatch,
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
    captionOverrides,
    setCaptionOverride,
    baseCaption,
    formError,
    submit,
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
