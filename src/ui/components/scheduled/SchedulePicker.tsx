"use client";

import { Button, Card, HStack, RadioList, RadioListItem, VStack } from "@astryxdesign/core";
import { useId } from "react";

import { ScheduleTimeField } from "@/ui/components/scheduled/ScheduleTimeField";
import { useNowMs } from "@/ui/hooks/useNowMs";
import type { ScheduleChoice } from "@/ui/hooks/useScheduleChoice";

/**
 * "Đăng ngay" / "Hẹn giờ đăng" (E8.1 UI) — one control, used by the compose
 * wizard (step 3) and by the bulk screen (core-component-reuse).
 *
 * Radios, not a switch: two named options make the default visible. "Đăng ngay"
 * is preselected, and the scheduled branch only appears once it is chosen —
 * nothing on screen while it is irrelevant. The branch sits on a muted card so
 * it reads as "belongs to the option above", not as a second, unrelated field.
 *
 * PENDING(E8.1-per-channel): one time for every channel of the batch. The API
 * already accepts `scheduledAtByChannel` (a bad hour blocks ONE channel, not the
 * lô), so per-channel golden hours are a UI change only — planned for a later
 * round and said here so nobody assumes the server cannot do it.
 */
export function SchedulePicker({
  choice,
  disabled,
  disabledReason,
  scopeNote,
}: {
  choice: ScheduleChoice;
  disabled?: boolean;
  /**
   * WHY the control is locked, forwarded to the time field. Only THIS screen
   * knows — "đang chạy lô" and "chế độ hỗ trợ chỉ được xem" are both `disabled`
   * here but are not the same sentence to an operator.
   */
  disabledReason?: string;
  /** What "mọi kênh" means on this screen (one post vs a whole run). */
  scopeNote: string;
}) {
  const groupId = useId();
  const fieldId = `${groupId}-at`;
  const nowMs = useNowMs();
  const slots = nowMs > 0 ? quickSlots(nowMs) : [];

  return (
    <VStack gap={3}>
      <RadioList
        label="Thời điểm đăng"
        description={scopeNote}
        htmlName={groupId}
        value={choice.mode}
        onChange={(next) => choice.setMode(next as ScheduleChoice["mode"])}
        isDisabled={disabled}
        // Disabled always comes with a reason (core-auth-session): with this set
        // Astryx keeps the radios focusable via aria-disabled, so the
        // explanation is reachable by keyboard and not mouse-only.
        disabledMessage={disabledReason}
      >
        <RadioListItem
          value="now"
          label="Đăng ngay"
          description="Bài vào hàng đợi ngay khi tạo lô; các kênh vẫn được đăng giãn cách theo cấu hình."
        />
        <RadioListItem
          value="scheduled"
          label="Hẹn giờ đăng"
          description="Bài chờ tới giờ đã hẹn. Trước khi tới giờ vẫn đổi giờ hoặc huỷ được ở màn “Bài đã hẹn”."
        />
      </RadioList>

      {choice.mode === "scheduled" ? (
        <Card variant="muted" padding={3}>
          <VStack gap={3}>
            <ScheduleTimeField
              id={fieldId}
              label="Giờ đăng"
              value={choice.value}
              onChange={choice.setValue}
              disabled={disabled}
              disabledReason={disabledReason}
              error={choice.error}
              nowMs={nowMs}
            />

            {slots.length > 0 ? (
              // `aria-pressed`, not a second radio group: these are shortcuts
              // that fill the field above, and the field stays the source of
              // truth. A slot that no longer matches simply reads unpressed.
              <HStack gap={1.5} wrap="wrap" role="group" aria-label="Giờ đăng gợi ý">
                {slots.map((slot) => (
                  <Button
                    key={slot.value}
                    size="sm"
                    variant={choice.value === slot.value ? "primary" : "secondary"}
                    label={slot.label}
                    aria-pressed={choice.value === slot.value}
                    isDisabled={disabled}
                    tooltip={disabled ? disabledReason : undefined}
                    onClick={() => choice.setValue(slot.value)}
                  />
                ))}
              </HStack>
            ) : null}
          </VStack>
        </Card>
      ) : null}
    </VStack>
  );
}

/**
 * The hours operators actually pick, as one-click chips.
 *
 * Built from the browser clock and filtered to the future, so "Tối nay 20:00"
 * disappears at 20:01 instead of offering a time the field would then reject.
 */
function quickSlots(nowMs: number): { label: string; value: string }[] {
  const day = 86_400_000;

  return [
    { label: "Tối nay 20:00", at: atLocalTime(nowMs, 20, 0) },
    { label: "Mai 09:00", at: atLocalTime(nowMs + day, 9, 0) },
    { label: "Mai 19:30", at: atLocalTime(nowMs + day, 19, 30) },
    { label: "Ngày mốt 12:00", at: atLocalTime(nowMs + 2 * day, 12, 0) },
  ]
    .filter((slot) => slot.at.getTime() > nowMs)
    .map((slot) => ({ label: slot.label, value: toDateTimeLocal(slot.at) }));
}

function atLocalTime(baseMs: number, hours: number, minutes: number): Date {
  const date = new Date(baseMs);
  date.setHours(hours, minutes, 0, 0);
  return date;
}

/** The time field wants LOCAL wall time, so never touch toISOString(). */
function toDateTimeLocal(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
