"use client";

import Link from "next/link";
import { useId } from "react";

import { ChannelGroupPicker } from "@/ui/components/compose/ChannelGroupPicker";
import { ApiErrorNotice } from "@/ui/components/feedback/ApiErrorNotice";
import { SchedulePicker } from "@/ui/components/scheduled/SchedulePicker";
import { Textarea } from "@/ui/components/ui/textarea";
import type { PublishForm } from "@/ui/hooks/usePublishForm";
import type { ComposeWizard } from "@/ui/hooks/useComposeWizard";
import { VIDEO_TARGET_LABELS } from "@/ui/schemas/compose.schema";

/**
 * Step 3, second half: pick the channels and set up the batch (E7.2 + E10.3).
 *
 * Fields only. The action that fires them ("Tạo lô đăng") sits in the wizard
 * footer, where every other step's primary action is — one place to look, on
 * every step. Both read the same `usePublishForm` instance, so the panel and
 * the footer can never disagree about whether the post may go out.
 *
 * What this panel is NOT allowed to render (business rule 2): stock, price or
 * production notes. The internal stock block belongs to step 1. The sentence
 * about the second stock check stays, because an operator who saw "còn hàng" on
 * step 1 must know the answer can still change at publish time (rule 3).
 *
 * Caption per channel (brief §7.2): "dùng chung" is offered because Phase 1 has
 * one AI caption and often several Pages, but it is the shortcut, not the goal —
 * hence the note telling the operator to make them distinct when it matters.
 */
export function PublishPanel({
  wizard,
  publish,
}: {
  wizard: ComposeWizard;
  publish: PublishForm;
}) {
  const shareId = useId();
  const { composed } = wizard;

  if (!composed) return null;

  const { selectedIds, groupItems } = publish;

  return (
    <aside
      aria-labelledby="publish-heading"
      className="bg-card border-border flex w-full shrink-0 flex-col gap-4 rounded-xl border p-5 @4xl:w-95"
    >
      <div className="space-y-1.5">
        <h3 id="publish-heading" className="text-base font-semibold">
          Đăng bài
        </h3>
        <p className="text-muted-foreground text-xs leading-relaxed">
          Mỗi kênh được tạo thành một bài riêng. Một kênh lỗi không làm dừng các kênh còn lại.
        </p>
      </div>

      <p className="bg-accent/25 rounded-lg px-3 py-2.5 text-xs">
        Loại bài sẽ tạo:{" "}
        <span className="font-semibold">
          {composed.video
            ? `${VIDEO_TARGET_LABELS[composed.video.target]} — 1 clip`
            : `Bài ảnh — ${wizard.album.length} ảnh`}
        </span>
      </p>

      <section className="space-y-2">
        <div className="flex items-baseline justify-between gap-2">
          <h4 className="text-sm font-medium">Chọn kênh</h4>
          <span className="text-muted-foreground text-xs">Đã chọn {selectedIds.length}</span>
        </div>
        <ChannelGroupPicker
          groups={groupItems}
          selected={publish.selected}
          onToggleChannel={publish.toggleChannel}
          onToggleGroup={publish.toggleGroup}
          loading={publish.groups.isPending && publish.groups.fetchStatus === "fetching"}
          error={publish.groups.isError ? publish.groups.error : undefined}
          onRetry={() => void publish.groups.refetch()}
          disabled={publish.isPending}
        />
        {groupItems.length > 0 ? (
          <p className="text-muted-foreground text-xs">
            <Link
              href="/channels/groups"
              className="text-accent-foreground underline underline-offset-4"
            >
              Quản lý nhóm kênh
            </Link>
          </p>
        ) : null}
      </section>

      <span aria-hidden="true" className="bg-border h-px" />

      <section className="space-y-2.5">
        <h4 className="text-sm font-medium">Caption cho từng kênh</h4>

        {/* A real checkbox under a switch skin: it keeps the label association,
            the keyboard behaviour and the announced role that a div cannot. */}
        <label htmlFor={shareId} className="flex cursor-pointer items-center gap-2.5 text-sm">
          <input
            id={shareId}
            type="checkbox"
            className="peer sr-only"
            checked={publish.shareCaption}
            disabled={publish.isPending}
            onChange={(event) => publish.setShareCaption(event.target.checked)}
          />
          {/* The knob is a descendant of the track, not a sibling of the input,
              so its moved state has to be written from the track's own rule —
              `peer-checked:` alone would never reach it. */}
          <span
            aria-hidden="true"
            className="bg-input peer-checked:bg-primary peer-focus-visible:ring-ring/50 peer-checked:[&>span]:translate-x-4 flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 transition-colors peer-focus-visible:ring-3"
          >
            <span className="bg-card size-4 rounded-full shadow-sm transition-transform" />
          </span>
          <span>Dùng chung caption đã duyệt cho mọi kênh</span>
        </label>

        <p className="text-muted-foreground text-xs leading-relaxed">
          Bỏ tick để sửa riêng từng kênh. Nên viết khác nhau khi đăng nhiều Fanpage — nội dung trùng
          hệt nhau dễ bị nền tảng coi là spam.
        </p>

        {!publish.shareCaption ? (
          selectedIds.length === 0 ? (
            <p className="text-muted-foreground text-xs">Chọn kênh trước để sửa caption riêng.</p>
          ) : (
            <ul className="space-y-2.5">
              {selectedIds.map((channelId) => (
                <li key={channelId} className="space-y-1.5">
                  <label htmlFor={`caption-${channelId}`} className="block">
                    <span className="font-mono text-xs break-all">{channelId}</span>
                  </label>
                  <Textarea
                    id={`caption-${channelId}`}
                    value={publish.captionOverrides[channelId] ?? publish.baseCaption}
                    onChange={(event) => publish.setCaptionOverride(channelId, event.target.value)}
                    disabled={publish.isPending}
                    spellCheck={false}
                  />
                </li>
              ))}
            </ul>
          )
        ) : (
          <p className="text-muted-foreground text-xs">
            Mọi kênh sẽ nhận đúng caption đã duyệt ở bước 2.
          </p>
        )}
      </section>

      <span aria-hidden="true" className="bg-border h-px" />

      <SchedulePicker
        choice={publish.schedule}
        disabled={publish.isPending}
        scopeNote="Áp dụng cho mọi kênh đã chọn ở trên. Hẹn giờ riêng cho từng kênh sẽ bổ sung sau."
      />

      <p className="bg-warning/15 text-warning-foreground rounded-lg px-3 py-2.5 text-xs leading-relaxed">
        Trước khi đăng, hệ thống kiểm tra tồn kho lần thứ hai ngay trước lời gọi đăng. Nếu lúc đó mã
        đã hết hàng, bài sẽ bị chặn và không lên — dù bước 1 vẫn báo còn hàng.
      </p>

      {publish.formError ? (
        <p role="alert" className="text-destructive text-xs">
          {publish.formError}
        </p>
      ) : null}

      {publish.createBatch.isError ? <ApiErrorNotice error={publish.createBatch.error} /> : null}

      <p className="text-muted-foreground text-xs leading-relaxed">
        {publish.schedule.mode === "scheduled"
          ? "Tạo xong sẽ chuyển sang màn “Bài đã hẹn”, nơi đổi giờ hoặc huỷ được trước khi tới giờ. Bạn có thể đóng tab — lịch vẫn chạy."
          : "Tạo xong sẽ chuyển sang màn theo dõi lô. Bạn có thể đóng tab — lô vẫn chạy."}
      </p>

      <p className="text-foreground-subtle text-xs leading-relaxed">
        Tự động đăng luôn mặc định TẮT: bài chỉ rời khỏi màn hình này khi có người bấm duyệt.
      </p>
    </aside>
  );
}
