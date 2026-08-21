"use client";

import { Banner, Button, HStack, Stack, Text } from "@astryxdesign/core";
import { useEffect, useId, useRef, useState } from "react";

/**
 * "Chạy đồng bộ" with a confirmation step.
 *
 * Confirmation is inline rather than a browser `confirm()` (which is not
 * styleable, not translatable and blocks the whole tab) and rather than a modal
 * (nothing here needs to trap focus). Focus moves to the confirm button so a
 * keyboard user lands on the decision; Escape cancels.
 *
 * The confirmation is a warning `Banner`: the sync overwrites the catalogue and
 * deletes what is no longer on the source, so the box says so in the design
 * system's own "be careful" treatment instead of a hand-tinted panel.
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
      <HStack gap={3} align="center" wrap="wrap">
        <Button
          ref={triggerRef}
          variant="primary"
          size="lg"
          label={isRunning ? "Đang đồng bộ…" : "Chạy đồng bộ"}
          isLoading={isRunning}
          isDisabled={disabled || isRunning}
          aria-describedby={isBlocked ? reasonId : undefined}
          onClick={() => setIsConfirming(true)}
        />
        {isBlocked ? (
          <Stack direction="vertical" maxWidth={340}>
            <Text id={reasonId} type="supporting">
              {disabledReason}
            </Text>
          </Stack>
        ) : null}
      </HStack>
    );
  }

  return (
    <Stack
      id={panelId}
      direction="vertical"
      role="group"
      aria-label="Xác nhận chạy đồng bộ"
      maxWidth={560}
      onKeyDown={(event) => {
        if (event.key === "Escape") cancel();
      }}
    >
      <Banner
        status="warning"
        title="Chạy đồng bộ toàn bộ dữ liệu?"
        description="Hệ thống sẽ đọc lại toàn bộ thư mục Drive và bảng Sheet, ghi đè dữ liệu sản phẩm/ảnh hiện có và xoá những mục không còn trên nguồn. Quá trình có thể mất vài phút — đừng đóng tab cho tới khi có kết quả."
        endContent={
          <HStack gap={2} align="center" wrap="wrap">
            <Button ref={confirmRef} variant="primary" label="Chạy ngay" onClick={confirm} />
            <Button variant="secondary" label="Huỷ" onClick={cancel} />
          </HStack>
        }
      />
    </Stack>
  );
}
