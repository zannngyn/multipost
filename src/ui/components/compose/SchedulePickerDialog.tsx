"use client";

import { CalendarClock } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/components/ui/dialog";
import { ScheduleTimeField } from "@/ui/components/scheduled/ScheduleTimeField";
import { useNowMs } from "@/ui/hooks/useNowMs";
import type { ScheduleChoice } from "@/ui/hooks/useScheduleChoice";

export interface SchedulePickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  choice: ScheduleChoice;
  onConfirmSchedule: () => void;
  disabled?: boolean;
  disabledReason?: string;
}

export function SchedulePickerDialog({
  open,
  onOpenChange,
  choice,
  onConfirmSchedule,
  disabled,
  disabledReason,
}: SchedulePickerDialogProps) {
  const nowMs = useNowMs();
  const resolved = choice.resolve();
  const isValid = resolved.ok;

  const handleConfirm = () => {
    if (!isValid) return;
    onOpenChange(false);
    onConfirmSchedule();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md p-6 gap-5 rounded-2xl border border-border shadow-xl">
        <DialogHeader className="gap-2 text-left">
          <div className="flex items-center gap-3">
            <div className="flex size-10 items-center justify-center rounded-xl bg-primary/10 text-primary shrink-0">
              <CalendarClock className="size-5" />
            </div>
            <div>
              <DialogTitle className="text-base font-bold">Hẹn lịch đăng bài</DialogTitle>
              <DialogDescription className="text-xs text-muted-foreground">
                Chọn ngày và giờ bạn muốn bài viết tự động xuất bản lên các kênh đã chọn.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="flex flex-col gap-3 py-1">
          <ScheduleTimeField
            id="compose-schedule-time"
            label="Ngày & Giờ hẹn đăng"
            value={choice.value}
            onChange={choice.setValue}
            disabled={disabled}
            disabledReason={disabledReason}
            error={choice.error}
            nowMs={nowMs}
          />
        </div>

        <DialogFooter className="flex items-center justify-end gap-2.5 pt-2 border-t border-border/60">
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="h-10 cursor-pointer rounded-xl border border-input bg-card px-4 text-xs font-semibold text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-all outline-none"
          >
            Thoát
          </button>

          <button
            type="button"
            disabled={!isValid || disabled}
            onClick={handleConfirm}
            className="flex h-10 cursor-pointer items-center justify-center rounded-xl bg-primary px-5 text-xs font-bold text-primary-foreground shadow-xs transition-all hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed outline-none"
          >
            Tiếp tục
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
