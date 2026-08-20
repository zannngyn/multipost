"use client";

import { useId } from "react";

import {
  avatarToneVar,
  channelInitials,
  publishableChannels,
} from "@/ui/components/compose/channel-picker";
import { SchedulePicker } from "@/ui/components/scheduled/SchedulePicker";
import { useChannels } from "@/ui/hooks/useChannels";
import type { PublishForm } from "@/ui/hooks/usePublishForm";

/**
 * "Kênh đăng" on the compose card — template lines 112–124: a mono FACEBOOK
 * label, the chosen Pages as pills, and a chevron opening the picker.
 *
 * This block only SUMMARISES. Choosing happens in `ChannelPickerDialog`, the
 * modal the design draws (161–191), which this row and the action bar both
 * open. Everything the mock does NOT put in the modal — caption chung, thời
 * điểm đăng, cảnh báo kiểm tồn lần hai — stays out here, under the summary.
 *
 * Caption editing is NOT here any more: one caption per channel lives in the
 * caption block, where the text is (`CaptionBlock`). This section answers
 * "where does this post go and when", nothing else.
 *
 * Page names come from the tenant's own channel list (`/api/channels`), so the
 * pills read "Lady Fashion" rather than an id. A Page that was removed since it
 * was ticked still shows: naming it is the only way an operator can find out
 * why one channel of the lô never went anywhere (business rule 5).
 */
export function ChannelChoice({
  publish,
  onOpenPicker,
  readOnlyReason,
}: {
  publish: PublishForm;
  onOpenPicker: () => void;
  readOnlyReason?: string | null;
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
        className="focus-visible:ring-ring flex cursor-pointer items-center gap-3 rounded-[var(--compose-radius-control)] bg-[var(--card)] px-3.5 py-3 text-left shadow-[inset_0_0_0_1px_var(--border)] outline-none focus-visible:ring-3"
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
                  className="flex h-9 items-center gap-2 rounded-full bg-[var(--compose-well)] py-0 pr-3.5 pl-1 shadow-[inset_0_0_0_1px_var(--compose-hairline)]"
                >
                  <span
                    aria-hidden="true"
                    style={{ background: avatarToneVar(label) }}
                    className="flex size-7 items-center justify-center rounded-full text-[10px] font-semibold text-white"
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
        <span className="shrink-0 text-[13px] font-medium text-[var(--primary)]">Sửa</span>
        <span aria-hidden="true" className="text-[15px] text-[var(--muted-foreground)]">
          ›
        </span>
      </button>

      <p className="text-xs text-[var(--muted-foreground)]">
        {selectedIds.length === 0
          ? "Mỗi kênh là một bài riêng; một kênh lỗi không dừng các kênh còn lại."
          : `Sẽ tạo ${selectedIds.length} bài, mỗi kênh một bài.`}
      </p>

      <span aria-hidden="true" className="my-1 h-px bg-[var(--compose-hairline)]" />

      <SchedulePicker
        choice={publish.schedule}
        disabled={publish.isPending || Boolean(readOnlyReason)}
        scopeNote="Áp dụng cho mọi kênh đã chọn ở trên. Hẹn giờ riêng cho từng kênh sẽ bổ sung sau."
      />

      <p className="rounded-lg bg-[var(--warning)]/15 px-3 py-2.5 text-xs leading-relaxed text-[var(--warning-foreground)]">
        Trước khi đăng, hệ thống kiểm tra tồn kho lần thứ hai ngay trước lời gọi đăng. Nếu lúc đó
        mã đã hết hàng, bài sẽ bị chặn và không lên — dù lúc soạn vẫn báo còn hàng.
      </p>
    </section>
  );
}
