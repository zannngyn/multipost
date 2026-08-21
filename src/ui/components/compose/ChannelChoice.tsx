"use client";

import { ChevronRight } from "lucide-react";
import { useId } from "react";

import {
  avatarToneStyle,
  channelInitials,
  publishableChannels,
} from "@/ui/components/compose/channel-picker";
import { useChannels } from "@/ui/hooks/useChannels";
import type { PublishForm } from "@/ui/hooks/usePublishForm";

/**
 * "Kênh đăng" on the compose card — template lines 112–124: a mono FACEBOOK
 * label, the chosen Pages as pills, and a chevron opening the picker.
 *
 * This block only SUMMARISES. Choosing happens in `ChannelPickerDialog`, the
 * modal the design draws (161–191), which this row and the action bar both
 * open.
 *
 * Neither the caption nor the schedule is here: one caption per channel lives
 * in the caption block, where the text is (`CaptionBlock`), and the time lives
 * in the sticky tray beside the button that uses it (`ComposeFocus`). There is
 * exactly ONE place on this screen to set the posting time — two of them was
 * how "đăng ngay" and "hẹn giờ" could be answered twice in one post. What is
 * left here answers "where does this post go", and the second stock check that
 * can still block it after it leaves.
 *
 * Page names come from the tenant's own channel list (`/api/channels`), so the
 * pills read "Lady Fashion" rather than an id. A Page that was removed since it
 * was ticked still shows: naming it is the only way an operator can find out
 * why one channel of the lô never went anywhere (business rule 5).
 */
export function ChannelChoice({
  publish,
  onOpenPicker,
}: {
  publish: PublishForm;
  onOpenPicker: () => void;
}) {
  const blockId = useId();
  const channels = useChannels();

  const byId = new Map(
    publishableChannels(channels.data?.channels ?? []).map((channel) => [
      channel.channelId,
      channel,
    ]),
  );
  const { selectedIds } = publish;
  const shown = selectedIds.slice(0, 3);

  return (
    <section aria-labelledby={`${blockId}-heading`} className="flex flex-col gap-2">
      <h3 id={`${blockId}-heading`} className="text-[13px] text-[var(--muted-foreground)]">
        Kênh đăng
      </h3>

      <button
        type="button"
        onClick={onOpenPicker}
        className="focus-visible:ring-ring flex cursor-pointer items-center gap-3 rounded-lg bg-[var(--card)] px-3.5 py-3 text-left shadow-[inset_0_0_0_1px_var(--border)] outline-none focus-visible:ring-3"
      >
        <span className="shrink-0 font-mono text-[10px] tracking-[0.1em] text-[var(--foreground-subtle)]">
          FACEBOOK
        </span>

        {selectedIds.length === 0 ? (
          <span className="text-[13px] text-[var(--muted-foreground)]">
            Chưa chọn kênh nào — bấm để chọn
          </span>
        ) : (
          <span className="flex min-w-0 flex-wrap items-center gap-2">
            {shown.map((channelId) => {
              const name = byId.get(channelId)?.name?.trim();
              const label = name && name.length > 0 ? name : channelId;

              return (
                <span
                  key={channelId}
                  className="flex h-9 items-center gap-2 rounded-full bg-[var(--muted)] py-0 pr-3.5 pl-1 shadow-[inset_0_0_0_1px_var(--border)]"
                >
                  <span
                    aria-hidden="true"
                    style={avatarToneStyle(label)}
                    className="flex size-7 items-center justify-center rounded-full text-[10px] font-semibold"
                  >
                    {channelInitials(label)}
                  </span>
                  <span className="max-w-45 truncate text-[13px] font-medium">{label}</span>
                </span>
              );
            })}
            {selectedIds.length > shown.length ? (
              <span className="text-[13px] text-[var(--muted-foreground)]">
                +{selectedIds.length - shown.length}
              </span>
            ) : null}
          </span>
        )}

        <span className="flex-1" />
        <span className="text-primary shrink-0 text-[13px] font-medium">Sửa</span>
        <ChevronRight aria-hidden="true" className="text-muted-foreground size-4 shrink-0" />
      </button>

      <p className="text-xs text-[var(--muted-foreground)]">
        {selectedIds.length === 0
          ? "Mỗi kênh là một bài riêng; một kênh lỗi không dừng các kênh còn lại."
          : `Sẽ tạo ${selectedIds.length} bài, mỗi kênh một bài.`}
      </p>

      <p className="bg-warning/15 text-warning-foreground rounded-lg px-3 py-2.5 text-xs leading-relaxed">
        Trước khi đăng, hệ thống kiểm tra tồn kho lần thứ hai ngay trước lời gọi đăng. Nếu lúc đó
        mã đã hết hàng, bài sẽ bị chặn và không lên — dù lúc soạn vẫn báo còn hàng.
      </p>
    </section>
  );
}
