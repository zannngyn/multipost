"use client";

import { Plus } from "lucide-react";

import { cn } from "@/shared/utils";
import { avatarToneStyle, channelInitials } from "@/ui/components/compose/channel-picker";
import type { Channel } from "@/ui/schemas/channel.schema";
import type { PublishForm } from "@/ui/hooks/usePublishForm";

export interface PostizSocialsBarProps {
  channels: readonly Channel[];
  publish: PublishForm;
  activeChannelId: string | null;
  onSelectActiveChannel: (channelId: string | null) => void;
  onOpenPicker?: () => void;
  disabled?: boolean;
}

export function PostizSocialsBar({
  channels,
  publish,
  activeChannelId,
  onSelectActiveChannel,
  onOpenPicker,
  disabled = false,
}: PostizSocialsBarProps) {
  const { selected, selectedIds, toggleChannel, setSelectedChannels } = publish;
  const isMasterActive = activeChannelId === null;
  const allSelected = channels.length > 0 && selectedIds.length === channels.length;

  const handleToggleAll = () => {
    if (disabled) return;
    if (!allSelected) {
      // Chọn tất cả các kênh và sáng lên hết
      setSelectedChannels(channels.map((c) => c.channelId));
      onSelectActiveChannel(null);
    } else {
      // Nếu đã chọn tất cả, chuyển về xem Master
      if (!isMasterActive) {
        onSelectActiveChannel(null);
      } else {
        // Nếu đang ở Master mà bấm lại -> Bỏ chọn tất cả
        setSelectedChannels([]);
      }
    }
  };

  const handleChannelClick = (channelId: string) => {
    if (disabled) return;
    const isSelected = selected.has(channelId);

    if (!isSelected) {
      // 1. Đang tắt -> 1 click BẬT NGAY (active) và chuyển tab đến kênh này
      toggleChannel(channelId, true);
      onSelectActiveChannel(channelId);
    } else {
      // 2. Đang bật -> 1 click TẮT NGAY (unactive)
      toggleChannel(channelId, false);
      if (activeChannelId === channelId) {
        onSelectActiveChannel(null);
      }
    }
  };

  return (
    <div className="flex flex-col gap-2.5 rounded-xl border border-border/70 bg-card/60 p-3.5 backdrop-blur-xs">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-semibold text-foreground">Kênh đăng</span>
          <span className="inline-flex items-center rounded-full bg-secondary px-2 py-0.5 text-[11px] font-medium text-secondary-foreground">
            {selectedIds.length}/{channels.length} đã chọn
          </span>
        </div>

        {onOpenPicker && (
          <button
            type="button"
            onClick={onOpenPicker}
            disabled={disabled}
            className="cursor-pointer text-[12px] font-medium text-primary hover:underline disabled:opacity-50"
          >
            Quản lý kênh
          </button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3.5 pt-1">
        {/* Nút "Tất cả" (Select All Toggle) */}
        <div className="relative flex flex-col items-center gap-1.5">
          <button
            type="button"
            disabled={disabled}
            onClick={handleToggleAll}
            className={cn(
              "relative flex size-12 cursor-pointer items-center justify-center rounded-full border-2 transition-all duration-200 outline-none select-none",
              allSelected
                ? "border-primary bg-primary text-primary-foreground shadow-md ring-2 ring-primary/30 scale-100 opacity-100"
                : "border-border/60 bg-muted/50 text-muted-foreground opacity-50 hover:opacity-100 hover:border-primary/50 hover:text-foreground",
            )}
            title={allSelected ? "Bấm để bỏ chọn tất cả các kênh" : "Bấm để chọn tất cả các kênh"}
          >
            <span className="text-xs font-bold uppercase tracking-wider">Tất cả</span>
          </button>
          <span
            className={cn(
              "max-w-16 truncate text-[11px] text-center transition-colors",
              allSelected ? "text-primary font-bold" : "text-muted-foreground",
            )}
          >
            Tất cả
          </span>
        </div>

        {/* Divider */}
        <span aria-hidden="true" className="h-8 w-px bg-border/80 self-start mt-2" />

        {/* Các kênh đơn lẻ */}
        {channels.map((channel) => {
          const isSelected = selected.has(channel.channelId);
          const isFocused = activeChannelId === channel.channelId;

          return (
            <div
              key={channel.channelId}
              className="relative flex flex-col items-center gap-1.5 group"
            >
              <button
                type="button"
                disabled={disabled}
                onClick={() => handleChannelClick(channel.channelId)}
                className={cn(
                  "relative flex size-12 cursor-pointer items-center justify-center rounded-full border-2 transition-all duration-200 outline-none select-none",
                  isSelected
                    ? "border-primary ring-2 ring-primary/30 shadow-md scale-100 opacity-100"
                    : "border-border/50 grayscale opacity-40 hover:opacity-80 hover:grayscale-0 hover:border-primary/40 hover:scale-105",
                  isFocused && isSelected && "ring-4 ring-primary/50 scale-105 border-primary",
                )}
                title={`${channel.name} (${isSelected ? (isFocused ? "Đang mở tab - Click để tắt kênh" : "Đã bật - Click để mở tab") : "Đang tắt - Click để bật"})`}
              >
                {/* Channel Avatar */}
                <span
                  style={avatarToneStyle(channel.name)}
                  className="flex size-11 items-center justify-center rounded-full text-xs font-bold text-white shadow-inner"
                >
                  {channelInitials(channel.name)}
                </span>

                {/* Platform Badge Overlay at bottom-right */}
                <span
                  className={cn(
                    "absolute -bottom-0.5 -right-0.5 flex size-4.5 items-center justify-center rounded-full border border-background shadow-xs text-[9px] font-bold text-white transition-transform",
                    channel.platform === "tiktok" ? "bg-black" : "bg-[#1877F2]",
                    !isSelected && "opacity-60",
                  )}
                >
                  {channel.platform === "tiktok" ? "TT" : "f"}
                </span>
              </button>

              {/* Channel Name */}
              <span
                className={cn(
                  "max-w-16 truncate text-[11px] text-center transition-colors",
                  isFocused ? "text-primary font-bold" : isSelected ? "text-foreground font-semibold" : "text-muted-foreground",
                )}
              >
                {channel.name}
              </span>
            </div>
          );
        })}

        {/* Add Channel Button if picker available */}
        {onOpenPicker && (
          <div className="flex flex-col items-center gap-1.5">
            <button
              type="button"
              onClick={onOpenPicker}
              disabled={disabled}
              className="flex size-12 cursor-pointer flex-col items-center justify-center rounded-full border-2 border-dashed border-border text-muted-foreground transition-all hover:border-primary hover:bg-primary/5 hover:text-primary"
              title="Thêm kênh mới"
            >
              <Plus className="size-5" />
            </button>
            <span className="text-[11px] font-medium text-muted-foreground">Thêm</span>
          </div>
        )}
      </div>
    </div>
  );
}
