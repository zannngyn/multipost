"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useMemo, useState } from "react";

import { ChannelGroupPicker } from "@/ui/components/compose/ChannelGroupPicker";
import { ApiErrorNotice } from "@/ui/components/feedback/ApiErrorNotice";
import { SchedulePicker } from "@/ui/components/scheduled/SchedulePicker";
import { Button } from "@/ui/components/ui/button";
import { Textarea } from "@/ui/components/ui/textarea";
import { useChannelGroups } from "@/ui/hooks/useChannelGroups";
import { useCreatePostBatch } from "@/ui/hooks/usePostBatch";
import { useScheduleChoice } from "@/ui/hooks/useScheduleChoice";
import type { ComposeWizard } from "@/ui/hooks/useComposeWizard";
import {
  COMPOSE_CHANNELS,
  VIDEO_TARGET_LABELS,
  postFormatForVideo,
} from "@/ui/schemas/compose.schema";

/**
 * Step 3, second half: pick the channels and create the batch (E7.2 + E10.3).
 *
 * What this panel is NOT allowed to do (business rules):
 *  - it never renders stock, price or production notes (rule 2) — the internal
 *    stock block belongs to step 1;
 *  - it never decides anything about stock: the server re-checks it when the
 *    batch is created AND again right before the Graph call (rule 3). The
 *    sentence below says so, because an operator seeing "còn hàng" on step 1
 *    must know the answer can still change at publish time;
 *  - it sends ASSETS, never image URLs — the signed public URL is minted
 *    server-side (E3.6), so nothing here can forge or leak one.
 *
 * Caption per channel (brief §7.2): "dùng chung" is offered because Phase 1 has
 * one AI caption and often several Pages, but it is the shortcut, not the goal —
 * hence the note telling the operator to make them distinct when it matters.
 */

const BASE_CHANNEL_ID = COMPOSE_CHANNELS[0].id;

export function PublishPanel({ wizard }: { wizard: ComposeWizard }) {
  const router = useRouter();
  const shareId = useId();
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

  const captionFor = (channelId: string): string =>
    (captionOverrides[channelId] ?? baseCaption).trim();
  const selectedIds = useMemo(() => [...selected], [selected]);
  const groupItems = groups.data?.groups ?? [];

  function toggleChannel(channelId: string, checked: boolean) {
    setFormError(null);
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(channelId);
      else next.delete(channelId);
      return next;
    });
  }

  function toggleGroup(channelIds: readonly string[], checked: boolean) {
    setFormError(null);
    setSelected((current) => {
      const next = new Set(current);
      for (const channelId of channelIds) {
        if (checked) next.add(channelId);
        else next.delete(channelId);
      }
      return next;
    });
  }

  function handleSubmit() {
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
    if (composed.video && composed.media.length !== 1) {
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
        // Cover first — `composePost` already ordered the album that way.
        media: composed.media.map((asset) => ({
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
  }

  if (!composed) return null;

  return (
    <section
      aria-labelledby="publish-heading"
      className="border-border bg-muted/30 space-y-5 rounded-xl border p-5"
    >
      <div className="space-y-1">
        <h3 id="publish-heading" className="text-base font-semibold">
          Đăng bài
        </h3>
        <p className="text-muted-foreground text-sm">
          Mỗi kênh được tạo thành một bài riêng. Một kênh lỗi không làm dừng các kênh còn lại.
        </p>
        <p className="text-muted-foreground text-sm">
          Loại bài sẽ tạo:{" "}
          <span className="text-foreground font-medium">
            {composed.video
              ? `${VIDEO_TARGET_LABELS[composed.video.target]} — 1 clip`
              : `Bài ảnh — ${composed.media.length} ảnh`}
          </span>
        </p>
      </div>

      <div className="space-y-2">
        <h4 className="text-sm font-medium">Chọn kênh</h4>
        <ChannelGroupPicker
          groups={groupItems}
          selected={selected}
          onToggleChannel={toggleChannel}
          onToggleGroup={toggleGroup}
          loading={groups.isPending && groups.fetchStatus === "fetching"}
          error={groups.isError ? groups.error : undefined}
          onRetry={() => void groups.refetch()}
          disabled={createBatch.isPending}
        />
        {groupItems.length > 0 ? (
          <p className="text-muted-foreground text-xs">
            Đã chọn {selectedIds.length} kênh.{" "}
            <Link href="/channels/groups" className="underline underline-offset-4">
              Quản lý nhóm kênh
            </Link>
          </p>
        ) : null}
      </div>

      <div className="space-y-3">
        <h4 className="text-sm font-medium">Caption cho từng kênh</h4>

        <label htmlFor={shareId} className="flex items-start gap-2 text-sm">
          <input
            id={shareId}
            type="checkbox"
            className="accent-primary mt-0.5 size-4"
            checked={shareCaption}
            disabled={createBatch.isPending}
            // Each box falls back to the approved caption, so switching to
            // per-channel editing never starts from a blank page.
            onChange={(event) => {
              setFormError(null);
              setShareCaption(event.target.checked);
            }}
          />
          <span>
            Dùng chung caption đã duyệt cho mọi kênh
            <span className="text-muted-foreground block text-xs">
              Bỏ tick để sửa riêng từng kênh. Nên viết khác nhau khi đăng nhiều Fanpage — nội dung
              trùng hệt nhau dễ bị nền tảng coi là spam.
            </span>
          </span>
        </label>

        {!shareCaption ? (
          selectedIds.length === 0 ? (
            <p className="text-muted-foreground text-sm">Chọn kênh trước để sửa caption riêng.</p>
          ) : (
            <ul className="space-y-3">
              {selectedIds.map((channelId) => (
                <li key={channelId} className="space-y-1.5">
                  <label htmlFor={`caption-${channelId}`} className="text-sm font-medium">
                    <span className="font-mono text-xs break-all">{channelId}</span>
                  </label>
                  <Textarea
                    id={`caption-${channelId}`}
                    value={captionOverrides[channelId] ?? baseCaption}
                    onChange={(event) =>
                      setCaptionOverrides((current) => ({
                        ...current,
                        [channelId]: event.target.value,
                      }))
                    }
                    disabled={createBatch.isPending}
                    spellCheck={false}
                  />
                </li>
              ))}
            </ul>
          )
        ) : (
          <p className="text-muted-foreground text-sm">
            Mọi kênh sẽ nhận đúng caption đã duyệt ở bước 2.
          </p>
        )}
      </div>

      <SchedulePicker
        choice={schedule}
        disabled={createBatch.isPending}
        scopeNote="Áp dụng cho mọi kênh đã chọn ở trên. Hẹn giờ riêng cho từng kênh sẽ bổ sung sau."
      />

      <p className="border-warning/40 bg-warning/10 text-warning-foreground rounded-lg border px-3 py-2 text-sm">
        Trước khi đăng, hệ thống kiểm tra tồn kho lần thứ hai ngay trước lời gọi đăng. Nếu lúc đó mã
        đã hết hàng, bài sẽ bị chặn và không lên — dù bước 1 vẫn báo còn hàng.
      </p>

      {formError ? (
        <p role="alert" className="text-destructive text-sm">
          {formError}
        </p>
      ) : null}

      {createBatch.isError ? <ApiErrorNotice error={createBatch.error} /> : null}

      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          size="lg"
          onClick={handleSubmit}
          disabled={createBatch.isPending || groupItems.length === 0}
        >
          {createBatch.isPending
            ? "Đang tạo lô…"
            : schedule.mode === "scheduled"
              ? "Tạo lô hẹn giờ"
              : "Tạo lô đăng"}
        </Button>
        <p className="text-muted-foreground text-sm">
          {schedule.mode === "scheduled"
            ? "Tạo xong sẽ chuyển sang màn “Bài đã hẹn”, nơi đổi giờ hoặc huỷ được trước khi tới giờ. Bạn có thể đóng tab — lịch vẫn chạy."
            : "Tạo xong sẽ chuyển sang màn theo dõi lô. Bạn có thể đóng tab — lô vẫn chạy."}
        </p>
      </div>

      <p className="text-muted-foreground text-xs">
        Tự động đăng luôn mặc định TẮT: bài chỉ rời khỏi màn hình này khi có người bấm duyệt.
      </p>
    </section>
  );
}
