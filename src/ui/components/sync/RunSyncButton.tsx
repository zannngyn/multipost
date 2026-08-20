"use client";

import { useEffect, useId, useRef, useState } from "react";

import { Button } from "@/ui/components/ui/button";

/**
 * "Chạy đồng bộ" with a confirmation step.
 *
 * Confirmation is inline rather than a browser `confirm()` (which is not
 * styleable, not translatable and blocks the whole tab) and rather than a modal
 * (nothing here needs to trap focus). Focus moves to the confirm button so a
 * keyboard user lands on the decision; Escape cancels.
 *
 * Presentational + local UI state only. The mutation lives in the hook above.
 */
export function RunSyncButton({
  onConfirm,
  isRunning,
  disabled,
  disabledReason,
}: {
  onConfirm: () => void;
  isRunning: boolean;
  /** True when there is no valid tenant to sync, or writing is off (M3.3). */
  disabled?: boolean;
  /**
   * Why it is off, when there is a reason worth reading. A dead control with no
   * explanation is what core-auth-session forbids; the sentence is rendered
   * next to the button rather than as a tooltip so it survives touch and
   * keyboard alike.
   */
  disabledReason?: string;
}) {
  const panelId = useId();
  const reasonId = `${panelId}-reason`;
  const [isConfirming, setIsConfirming] = useState(false);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (isConfirming) confirmRef.current?.focus();
  }, [isConfirming]);

  function cancel() {
    setIsConfirming(false);
    triggerRef.current?.focus();
  }

  function confirm() {
    // Closed here, in the event handler, and not in an effect watching
    // `isRunning`: the panel must disappear the moment the operator decides.
    setIsConfirming(false);
    onConfirm();
  }

  if (!isConfirming || isRunning) {
    const isBlocked = Boolean(disabled) && !isRunning && Boolean(disabledReason);

    return (
      <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Button
          ref={triggerRef}
          type="button"
          size="lg"
          onClick={() => setIsConfirming(true)}
          disabled={disabled || isRunning}
          aria-describedby={
            isRunning ? `${panelId}-running` : isBlocked ? reasonId : undefined
          }
        >
          {isRunning ? "Đang đồng bộ…" : "Chạy đồng bộ"}
        </Button>
        {isBlocked ? (
          <span id={reasonId} className="text-muted-foreground max-w-prose text-sm">
            {disabledReason}
          </span>
        ) : null}
      </span>
    );
  }

  return (
    <div
      id={panelId}
      role="group"
      aria-label="Xác nhận chạy đồng bộ"
      onKeyDown={(event) => {
        if (event.key === "Escape") cancel();
      }}
      className="border-warning/40 bg-warning/5 w-full max-w-xl space-y-3 rounded-xl border p-4"
    >
      <p className="text-sm font-medium">Chạy đồng bộ toàn bộ dữ liệu?</p>
      <p className="text-muted-foreground text-sm">
        Hệ thống sẽ đọc lại toàn bộ thư mục Drive và bảng Sheet, ghi đè dữ liệu sản phẩm/ảnh hiện có
        và xoá những mục không còn trên nguồn. Quá trình có thể mất vài phút — đừng đóng tab cho tới
        khi có kết quả.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button ref={confirmRef} type="button" onClick={confirm}>
          Chạy ngay
        </Button>
        <Button type="button" variant="outline" onClick={cancel}>
          Huỷ
        </Button>
      </div>
    </div>
  );
}
