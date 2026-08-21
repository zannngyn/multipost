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
  VStack,
} from "@astryxdesign/core";
import { useId, useState } from "react";

import { ApiErrorNotice } from "@/ui/components/feedback/ApiErrorNotice";
import { ScheduleTimeField } from "@/ui/components/scheduled/ScheduleTimeField";
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
 * `purpose="form"`: a mis-aimed click on the backdrop must not throw away the
 * hour the operator just picked (core-form-architecture §bảng phân xử).
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

  const subtitle = job
    ? `Bài ${job.productCode}${job.color.trim() ? ` · ${job.color}` : ""} trên kênh ${job.channelId}. Đang hẹn lúc ${formatScheduledAt(job.scheduledAt)}.`
    : "Không tìm thấy bài này trong danh sách đang xem — có thể bài đã đăng, đã huỷ, hoặc nằm ở trang khác.";

  const header = (
    <DialogHeader title="Đổi giờ đăng" subtitle={subtitle} onOpenChange={onOpenChange} />
  );

  // --- Nothing to edit: a dead end said plainly, with one way out ------------
  if (!job || blockedReason) {
    return (
      <Dialog isOpen={open} onOpenChange={onOpenChange} purpose="info" width={520}>
        <Layout
          header={header}
          content={
            <LayoutContent>
              {blockedReason ? (
                <Banner status="warning" role="status" title={blockedReason} />
              ) : (
                <Text type="supporting" role="status">
                  Đóng hộp thoại rồi bấm “Tải lại” để xem danh sách mới nhất. Nếu bài đã đăng hoặc
                  đã huỷ, kết quả của nó nằm ở Nhật ký đăng bài.
                </Text>
              )}
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
    <Dialog isOpen={open} onOpenChange={onOpenChange} purpose="form" width={520}>
      {/* noValidate: the messages below are ours, not the browser's. */}
      <form noValidate onSubmit={handleSubmit}>
        <Layout
          header={header}
          content={
            <LayoutContent>
              <VStack gap={4}>
                <ScheduleTimeField
                  id={fieldId}
                  label="Giờ đăng mới"
                  value={value}
                  onChange={(next) => {
                    setFormError(null);
                    setValue(next);
                  }}
                  disabled={isPending}
                  disabledReason="Đang lưu giờ mới — chờ lưu xong rồi mới sửa tiếp được."
                  error={formError}
                  nowMs={nowMs}
                />

                <Text type="supporting">
                  Đổi giờ không bỏ qua bất kỳ quy tắc nào: tồn kho vẫn được kiểm tra lại ngay trước
                  khi đăng, nên bài vẫn có thể bị chặn nếu lúc đó mã đã hết hàng.
                </Text>

                {isQueueWarning ? (
                  <Banner
                    status="warning"
                    role="alert"
                    title="Giờ đã đổi, nhưng chưa vào được hàng đợi"
                    description="Hệ thống đã lưu giờ mới, nhưng chưa xếp được bài vào hàng đợi đăng. Bài sẽ KHÔNG tự lên vào giờ mới cho tới khi thao tác này chạy lại thành công — và vẫn có thể lên vào giờ cũ. Hãy bấm “Lưu giờ mới” lần nữa sau ít phút; nếu vẫn lỗi, báo quản trị viên."
                  />
                ) : error ? (
                  <ApiErrorNotice error={error} />
                ) : null}
              </VStack>
            </LayoutContent>
          }
          footer={
            <LayoutFooter>
              <HStack gap={2} hAlign="end">
                <Button
                  type="button"
                  variant="ghost"
                  label="Đóng"
                  isDisabled={isPending}
                  onClick={() => onOpenChange(false)}
                />
                {/* Never disabled on "invalid": the operator presses it and the
                    field says what is wrong (core-form-architecture §submit). */}
                <Button
                  type="submit"
                  variant="primary"
                  label={isPending ? "Đang lưu…" : "Lưu giờ mới"}
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
