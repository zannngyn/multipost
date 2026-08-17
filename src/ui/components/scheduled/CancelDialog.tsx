"use client";

import { useId, useState } from "react";

import { ApiErrorNotice } from "@/ui/components/feedback/ApiErrorNotice";
import { Button } from "@/ui/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/components/ui/dialog";
import { Textarea } from "@/ui/components/ui/textarea";
import {
  MAX_CANCEL_NOTE_LENGTH,
  formatScheduledAt,
  isHeldByPlatform,
  type ScheduledJobEntry,
} from "@/ui/schemas/scheduled.schema";
import type { ApiError } from "@/ui/services/api-error";

/**
 * "Huỷ bài hẹn" (E8.4) — a destructive action, so it is confirmed, and the
 * consequence is spelled out BEFORE the button (core-booking-scheduling r.6):
 * the job ends up blocked and never publishes; re-posting means composing again.
 *
 * The note is optional and free text. It is stored in the audit payload, which
 * is what turns "vì sao bài này không lên" into a human answer instead of a log
 * archaeology session (business rule 5).
 */
export function CancelDialog({
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
  onSubmit: (params: { postJobId: string; note?: string }) => void;
  isPending: boolean;
  error: ApiError | null;
}) {
  const noteId = useId();
  const [note, setNote] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setFormError(null);

    // --- Edge cases first ---------------------------------------------------
    if (!job) {
      setFormError("Không xác định được bài cần huỷ. Hãy đóng và tải lại danh sách.");
      return;
    }
    const trimmed = note.trim();
    if (trimmed.length > MAX_CANCEL_NOTE_LENGTH) {
      setFormError(`Ghi chú tối đa ${MAX_CANCEL_NOTE_LENGTH} ký tự.`);
      return;
    }

    onSubmit({ postJobId: job.postJobId, ...(trimmed.length > 0 ? { note: trimmed } : {}) });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Huỷ bài đã hẹn?</DialogTitle>
          <DialogDescription>
            {job
              ? `Bài ${job.productCode}${job.color.trim() ? ` · ${job.color}` : ""} trên kênh ${job.channelId}, đang hẹn lúc ${formatScheduledAt(job.scheduledAt)}.`
              : "Không tìm thấy bài này trong danh sách đang xem — có thể bài đã đăng, đã huỷ, hoặc nằm ở trang khác."}
          </DialogDescription>
        </DialogHeader>

        {job ? (
          <form noValidate className="space-y-4" onSubmit={handleSubmit}>
            <p className="border-warning/40 bg-warning/10 text-warning-foreground rounded-lg border px-3 py-2 text-sm">
              {isHeldByPlatform(job.status)
                ? // E8.6: this cancel reaches OUT to Facebook and deletes the
                  // post there first. Saying only "chuyển sang Bị chặn" would
                  // hide the part the operator can verify on the Page.
                  //
                  // The removal CAN fail (dead page token, Graph down), and the
                  // usecase then refuses the cancel with the post still
                  // scheduled — so this is worded as an attempt, not a promise.
                  // "Facebook sẽ không đăng nữa" belongs to the success message
                  // the server sends back, where it is true.
                  "Bài này đang được Facebook giữ. Khi bấm huỷ, hệ thống sẽ cố gỡ bài khỏi Facebook trước, gỡ được mới đánh dấu “Bị chặn”. Nếu không gỡ được, màn hình sẽ báo lại kèm hướng dẫn — bài vẫn sẽ tự đăng cho tới khi bạn vào Trang xoá tay. Không hoàn tác được: muốn đăng lại thì phải soạn bài mới. Các kênh khác trong cùng lô không bị ảnh hưởng."
                : "Huỷ xong bài sẽ chuyển sang trạng thái “Bị chặn” và không bao giờ lên kênh này. Không hoàn tác được: muốn đăng lại thì phải soạn bài mới. Các kênh khác trong cùng lô không bị ảnh hưởng."}
            </p>

            <div className="space-y-1.5">
              <label htmlFor={noteId} className="text-sm font-medium">
                Lý do huỷ (không bắt buộc)
              </label>
              <Textarea
                id={noteId}
                value={note}
                rows={3}
                maxLength={MAX_CANCEL_NOTE_LENGTH}
                disabled={isPending}
                onChange={(event) => {
                  setFormError(null);
                  setNote(event.target.value);
                }}
                aria-describedby={`${noteId}-hint`}
                placeholder="Ví dụ: mẫu này đổi ảnh, chờ ảnh mới."
              />
              <p id={`${noteId}-hint`} className="text-muted-foreground text-xs">
                Lý do được ghi vào nhật ký hệ thống kèm người huỷ, để sau này còn tra được vì sao
                bài không lên. Hiện chưa hiển thị lại trên màn hình nào.
              </p>
            </div>

            {formError ? (
              <p role="alert" className="text-destructive text-sm">
                {formError}
              </p>
            ) : null}

            {/*
              `operation="cancel"`: a failure here is a failed REMOVAL, not a
              rejected post. Without it the block borrowed the publish wording
              ("Chạy lại"), which is the opposite of what a post Facebook still
              holds needs — see present-api-error.
            */}
            {error ? <ApiErrorNotice error={error} operation="cancel" /> : null}

            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={() => onOpenChange(false)}
                disabled={isPending}
              >
                Giữ lịch đăng
              </Button>
              <Button type="submit" variant="destructive" disabled={isPending}>
                {isPending ? "Đang huỷ…" : "Huỷ bài này"}
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
