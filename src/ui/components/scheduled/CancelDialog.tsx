"use client";

import {
  Banner,
  Button,
  Dialog,
  DialogHeader,
  HStack,
  Layout,
  LayoutContent,
  LayoutFooter,
  Text,
  TextArea,
  VStack,
} from "@astryxdesign/core";
import { useState } from "react";

import { ApiErrorNotice } from "@/ui/components/feedback/ApiErrorNotice";
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
 * `purpose="form"`: the note is typed here, and a mis-aimed backdrop click must
 * not throw it away. The consequence sits in a warning Banner above the note, so
 * it cannot be scrolled past on the way to the button.
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

  const subtitle = job
    ? `Bài ${job.productCode}${job.color.trim() ? ` · ${job.color}` : ""} trên kênh ${job.channelId}, đang hẹn lúc ${formatScheduledAt(job.scheduledAt)}.`
    : "Không tìm thấy bài này trong danh sách đang xem — có thể bài đã đăng, đã huỷ, hoặc nằm ở trang khác.";

  const header = (
    <DialogHeader title="Huỷ bài đã hẹn?" subtitle={subtitle} onOpenChange={onOpenChange} />
  );

  // --- Nothing to cancel: a dead end said plainly, with one way out ----------
  if (!job) {
    return (
      <Dialog isOpen={open} onOpenChange={onOpenChange} purpose="info" width={520}>
        <Layout
          header={header}
          content={
            <LayoutContent>
              <Text type="supporting" role="status">
                Đóng hộp thoại rồi bấm “Tải lại” để xem danh sách mới nhất. Nếu bài đã đăng hoặc đã
                huỷ, kết quả của nó nằm ở Nhật ký đăng bài.
              </Text>
            </LayoutContent>
          }
          footer={
            <LayoutFooter>
              <HStack gap={2} hAlign="end">
                <Button variant="primary" label="Đóng" onClick={() => onOpenChange(false)} />
              </HStack>
            </LayoutFooter>
          }
        />
      </Dialog>
    );
  }

  return (
    <Dialog isOpen={open} onOpenChange={onOpenChange} purpose="form" width={560}>
      <form noValidate onSubmit={handleSubmit}>
        <Layout
          header={header}
          content={
            <LayoutContent>
              <VStack gap={4}>
                <Banner
                  status="warning"
                  title="Huỷ rồi thì không hoàn tác được"
                  description={
                    isHeldByPlatform(job.status)
                      ? // E8.6: this cancel reaches OUT to Facebook and deletes
                        // the post there first. Saying only "chuyển sang Bị
                        // chặn" would hide the part the operator can verify on
                        // the Page.
                        //
                        // The removal CAN fail (dead page token, Graph down),
                        // and the usecase then refuses the cancel with the post
                        // still scheduled — so this is worded as an attempt, not
                        // a promise. "Facebook sẽ không đăng nữa" belongs to the
                        // success message the server sends back, where it is
                        // true.
                        "Bài này đang được Facebook giữ. Khi bấm huỷ, hệ thống sẽ cố gỡ bài khỏi Facebook trước, gỡ được mới đánh dấu “Bị chặn”. Nếu không gỡ được, màn hình sẽ báo lại kèm hướng dẫn — bài vẫn sẽ tự đăng cho tới khi bạn vào Trang xoá tay. Không hoàn tác được: muốn đăng lại thì phải soạn bài mới. Các kênh khác trong cùng lô không bị ảnh hưởng."
                      : "Huỷ xong bài sẽ chuyển sang trạng thái “Bị chặn” và không bao giờ lên kênh này. Không hoàn tác được: muốn đăng lại thì phải soạn bài mới. Các kênh khác trong cùng lô không bị ảnh hưởng."
                  }
                />

                <TextArea
                  label="Lý do huỷ"
                  isOptional
                  value={note}
                  rows={3}
                  maxLength={MAX_CANCEL_NOTE_LENGTH}
                  isDisabled={isPending}
                  disabledMessage="Đang huỷ — chờ xong rồi mới sửa tiếp được."
                  onChange={(next) => {
                    setFormError(null);
                    setNote(next);
                  }}
                  placeholder="Ví dụ: mẫu này đổi ảnh, chờ ảnh mới."
                  description="Lý do được ghi vào nhật ký hệ thống kèm người huỷ, để sau này còn tra được vì sao bài không lên. Hiện chưa hiển thị lại trên màn hình nào."
                  status={formError ? { type: "error", message: formError } : undefined}
                  statusVariant="detached"
                  width="100%"
                />

                {/*
                  `operation="cancel"`: a failure here is a failed REMOVAL, not a
                  rejected post. Without it the block borrowed the publish
                  wording ("Chạy lại"), which is the opposite of what a post
                  Facebook still holds needs — see present-api-error.
                */}
                {error ? <ApiErrorNotice error={error} operation="cancel" /> : null}
              </VStack>
            </LayoutContent>
          }
          footer={
            <LayoutFooter>
              <HStack gap={2} hAlign="end">
                <Button
                  type="button"
                  variant="ghost"
                  label="Giữ lịch đăng"
                  isDisabled={isPending}
                  onClick={() => onOpenChange(false)}
                />
                <Button
                  type="submit"
                  variant="destructive"
                  label={isPending ? "Đang huỷ…" : "Huỷ bài này"}
                  isLoading={isPending}
                  isDisabled={isPending}
                />
              </HStack>
            </LayoutFooter>
          }
        />
      </form>
    </Dialog>
  );
}
