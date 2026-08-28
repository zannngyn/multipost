"use client";

import { AlertTriangle, Clock } from "lucide-react";
import { cn } from "@/shared/utils";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/components/ui/dialog";
import { formatScheduledAt } from "@/ui/schemas/scheduled.schema";

export interface PublishConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  isPending: boolean;
  isScheduled: boolean;
  scheduledAt?: string | null;
  channels: readonly { id: string; name: string; platform?: string }[];
  mediaCount: number;
  isVideo: boolean;
  productCode?: string;
  captionPreview?: string;
}

export function PublishConfirmDialog({
  open,
  onOpenChange,
  onConfirm,
  isPending,
  isScheduled,
  scheduledAt,
  channels,
  mediaCount,
  isVideo,
  productCode,
}: PublishConfirmDialogProps) {
  const isNow = !isScheduled;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md p-6 gap-4.5 rounded-2xl border border-border shadow-xl">
        <DialogHeader className="gap-2 text-left">
          <div className="flex items-center gap-3">
            <div className="flex size-10 items-center justify-center rounded-xl bg-amber-500/10 text-amber-600 dark:text-amber-400 shrink-0">
              <AlertTriangle className="size-5" />
            </div>
            <div>
              <DialogTitle className="text-base font-bold">
                {isNow ? "Xác nhận xuất bản bài đăng" : "Xác nhận lên lịch đăng bài"}
              </DialogTitle>
              <DialogDescription className="text-xs text-muted-foreground">
                {isNow
                  ? "Bài viết sẽ được đăng trực tiếp lên mạng xã hội và không thể hoàn tác."
                  : "Bài viết sẽ vào hàng đợi và tự động xuất bản theo giờ đã hẹn."}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        {/* Thông tin tóm tắt bài đăng */}
        <div className="flex flex-col divide-y divide-border/60 rounded-xl border border-border bg-muted/20 text-xs">
          {/* Danh sách kênh */}
          <div className="flex items-start justify-between p-3 gap-3">
            <span className="text-muted-foreground font-medium shrink-0">Kênh đăng</span>
            <div className="flex flex-wrap justify-end gap-1.5 text-right">
              {channels.map((ch) => (
                <span
                  key={ch.id}
                  className="rounded-md bg-card border border-border/70 px-2 py-0.5 font-semibold text-foreground"
                >
                  {ch.name}
                </span>
              ))}
            </div>
          </div>

          {/* Thời điểm */}
          <div className="flex items-center justify-between p-3 gap-3">
            <span className="text-muted-foreground font-medium">Thời điểm</span>
            <span className="font-semibold text-foreground">
              {isNow
                ? "Đăng ngay"
                : scheduledAt
                  ? formatScheduledAt(scheduledAt)
                  : "Theo lịch đã chọn"}
            </span>
          </div>

          {/* Nội dung đính kèm */}
          <div className="flex items-center justify-between p-3 gap-3">
            <span className="text-muted-foreground font-medium">Nội dung</span>
            <span className="font-medium text-foreground">
              {productCode ? <span className="font-mono font-bold mr-1">{productCode} •</span> : null}
              <span>{isVideo ? "1 Video" : `${mediaCount} hình ảnh`}</span>
            </span>
          </div>
        </div>

        <DialogFooter className="flex items-center justify-end gap-2.5 pt-1">
          <button
            type="button"
            disabled={isPending}
            onClick={() => onOpenChange(false)}
            className="h-10 cursor-pointer rounded-xl border border-input bg-card px-4 text-xs font-semibold text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-all outline-none"
          >
            Hủy
          </button>

          <button
            type="button"
            disabled={isPending}
            onClick={onConfirm}
            className={cn(
              "flex h-10 cursor-pointer items-center justify-center rounded-xl bg-primary px-5 text-xs font-bold text-primary-foreground shadow-xs transition-all hover:opacity-90 outline-none",
              isPending && "opacity-50 cursor-not-allowed",
            )}
          >
            {isPending ? (
              <span>Đang xử lý…</span>
            ) : (
              <span>{isNow ? "Xác nhận" : "Xác nhận"}</span>
            )}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
