"use client";

import { useId, useState } from "react";

import { ApiErrorNotice } from "@/ui/components/feedback/ApiErrorNotice";
import { ScheduleTimeField } from "@/ui/components/scheduled/ScheduleTimeField";
import { Button } from "@/ui/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/components/ui/dialog";
import { useNowMs } from "@/ui/hooks/useNowMs";
import {
  formatScheduledAt,
  rescheduleBlockedReason,
  toDateTimeLocalValue,
  validateScheduleInput,
  type ScheduledJobEntry,
} from "@/ui/schemas/scheduled.schema";
import type { ApiError } from "@/ui/services/api-error";

/**
 * "Đổi giờ" (E8.4). Opened by a URL parameter, so F5 and a shared link both
 * land back on it with the list rendered behind (web-crud-inline-edit rule 1).
 *
 * `job === null` with the dialog open means the deep link points at a row that
 * is not in the loaded pages — usually because it already published or was
 * cancelled. That is said out loud instead of showing an empty form.
 *
 * QUEUE_ERROR is NOT rendered as a plain failure: the new time IS stored, only
 * the queue entry is missing. Telling the operator "đổi giờ thất bại" there
 * would be a lie that leaves a post silently un-queued.
 */
export function RescheduleDialog({
  job,
  open,
  onOpenChange,
  onSubmit,
  isPending,
  error,
}: {
  job: ScheduledJobEntry | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (params: { postJobId: string; scheduledAt: string }) => void;
  isPending: boolean;
  error: ApiError | null;
}) {
  const fieldId = useId();
  const nowMs = useNowMs();
  const [value, setValue] = useState(() =>
    job ? toDateTimeLocalValue(new Date(job.scheduledAt)) : "",
  );
  const [formError, setFormError] = useState<string | null>(null);

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setFormError(null);

    // --- Edge cases first: nothing leaves the browser until they all pass ---
    if (!job) {
      setFormError("Không xác định được bài cần đổi giờ. Hãy đóng và tải lại danh sách.");
      return;
    }
    const verdict = validateScheduleInput(value, Date.now());
    if (!verdict.ok) {
      setFormError(verdict.message);
      return;
    }
    if (verdict.iso === job.scheduledAt) {
      setFormError("Giờ mới trùng với giờ đang hẹn — chọn một thời điểm khác.");
      return;
    }

    onSubmit({ postJobId: job.postJobId, scheduledAt: verdict.iso });
  }

  const isQueueWarning = error?.code === "QUEUE_ERROR";
  /**
   * The dialog lives in the URL, so a deep link (or a page left open while the
   * worker handed the post to Facebook) can reach a row the server will refuse.
   * Show the reason instead of a form that can only ever come back with a 409.
   */
  const blockedReason =
    job && !job.canReschedule
      ? (rescheduleBlockedReason(job) ??
        "Bài này đã qua giờ hẹn nên không đổi giờ được nữa — hãy mở nhật ký để xem kết quả.")
      : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby={`${fieldId}-dialog-description`}>
        <DialogHeader>
          <DialogTitle>Đổi giờ đăng</DialogTitle>
          <DialogDescription id={`${fieldId}-dialog-description`}>
            {job
              ? `Bài ${job.productCode}${job.color.trim() ? ` · ${job.color}` : ""} trên kênh ${job.channelId}. Đang hẹn lúc ${formatScheduledAt(job.scheduledAt)}.`
              : "Không tìm thấy bài này trong danh sách đang xem — có thể bài đã đăng, đã huỷ, hoặc nằm ở trang khác."}
          </DialogDescription>
        </DialogHeader>

        {job && blockedReason ? (
          <>
            <p
              role="status"
              className="border-warning/40 bg-warning/10 text-warning-foreground rounded-lg border px-3 py-2 text-sm"
            >
              {blockedReason}
            </p>
            <DialogFooter>
              <Button type="button" onClick={() => onOpenChange(false)}>
                Đóng
              </Button>
            </DialogFooter>
          </>
        ) : job ? (
          <form noValidate className="space-y-4" onSubmit={handleSubmit}>
            <ScheduleTimeField
              id={fieldId}
              label="Giờ đăng mới"
              value={value}
              onChange={(next) => {
                setFormError(null);
                setValue(next);
              }}
              disabled={isPending}
              error={formError}
              nowMs={nowMs}
            />

            <p className="text-muted-foreground text-sm">
              Đổi giờ không bỏ qua bất kỳ quy tắc nào: tồn kho vẫn được kiểm tra lại ngay trước khi
              đăng, nên bài vẫn có thể bị chặn nếu lúc đó mã đã hết hàng.
            </p>

            {isQueueWarning ? (
              <div className="border-warning/40 bg-warning/10 text-warning-foreground space-y-1 rounded-lg border px-3 py-2 text-sm">
                <p className="font-medium">Giờ đã đổi, nhưng chưa vào được hàng đợi</p>
                <p>
                  Hệ thống đã lưu giờ mới, nhưng chưa xếp được bài vào hàng đợi đăng. Bài sẽ KHÔNG
                  tự lên vào giờ mới cho tới khi thao tác này chạy lại thành công — và vẫn có thể
                  lên vào giờ cũ. Hãy bấm “Lưu giờ mới” lần nữa sau ít phút; nếu vẫn lỗi, báo quản
                  trị viên.
                </p>
              </div>
            ) : error ? (
              <ApiErrorNotice error={error} />
            ) : null}

            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={() => onOpenChange(false)}
                disabled={isPending}
              >
                Đóng
              </Button>
              <Button type="submit" disabled={isPending}>
                {isPending ? "Đang lưu…" : "Lưu giờ mới"}
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <DialogFooter>
            <Button type="button" onClick={() => onOpenChange(false)}>
              Đóng
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
