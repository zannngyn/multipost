"use client";

import { DateTimeInput, Text, VStack, type ISODateTimeString } from "@astryxdesign/core";

import {
  MAX_SCHEDULE_AHEAD_DAYS,
  formatCountdown,
  formatScheduledAt,
  scheduleInputBounds,
  timeZoneLabel,
  validateScheduleInput,
} from "@/ui/schemas/scheduled.schema";

/**
 * THE publish-time field. One component for the compose wizard, the bulk screen
 * and the "đổi giờ" dialog (core-component-reuse: three copies of a date field
 * is three places to get the timezone wrong).
 *
 * Astryx `DateTimeInput`, and the VALUE CONTRACT IS UNCHANGED: it is still local
 * wall time, "YYYY-MM-DDTHH:mm" — exactly what `<input type="datetime-local">`
 * produced and exactly what `validateScheduleInput` and the dialogs already
 * expect. Nothing downstream of this file had to move. What the swap buys is a
 * calendar the operator can pick from, a time field that steps with the arrow
 * keys, and one label/description/error wiring instead of three hand-rolled
 * `aria-describedby` strings.
 *
 * `hourFormat="24h"` and `weekStartsOn="mon"`: "đăng lúc 20h" is how the hour is
 * said here, and a Vietnamese wall calendar starts on Thứ Hai. Neither is a
 * default we can inherit.
 *
 * The window is stated BEFORE a choice is made (core-booking-scheduling rule 5):
 * `min`/`max` on the field, and the same sentence in the description for anyone
 * whose browser ignores them. The client check is a courtesy — the server
 * re-validates and has the final say.
 */
export function ScheduleTimeField({
  id,
  label,
  value,
  onChange,
  disabled,
  disabledReason,
  error,
  nowMs,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  /**
   * WHY the field is locked. Disabled always comes with a reason
   * (core-auth-session): with this set Astryx keeps the field focusable via
   * `aria-disabled` and surfaces the sentence on hover AND on keyboard focus,
   * so the explanation is not mouse-only.
   */
  disabledReason?: string;
  /** Message from the last submit attempt or from the server. */
  error?: string | null;
  /** 0 before the browser clock is known — the preview then stays quiet. */
  nowMs: number;
}) {
  const zone = timeZoneLabel();
  const bounds = nowMs > 0 ? scheduleInputBounds(nowMs) : null;
  // One trim, reused: a value of "   " is not a value, and must not be handed
  // to the field as if it were an ISO datetime.
  const trimmed = typeof value === "string" ? value.trim() : "";
  const verdict = nowMs > 0 && trimmed.length > 0 ? validateScheduleInput(trimmed, nowMs) : null;

  return (
    <VStack gap={1.5} maxWidth={340}>
      <DateTimeInput
        id={id}
        label={label}
        // Local wall time in, local wall time out — the branded type is Astryx's
        // way of saying "ISO datetime", which is the shape this value already has.
        value={trimmed.length > 0 ? (trimmed as ISODateTimeString) : undefined}
        onChange={(next) => onChange(next ?? "")}
        min={bounds ? (bounds.min as ISODateTimeString) : undefined}
        max={bounds ? (bounds.max as ISODateTimeString) : undefined}
        isDisabled={disabled}
        disabledMessage={disabled ? disabledReason : undefined}
        hourFormat="24h"
        timeIncrement={15}
        weekStartsOn="mon"
        placeholder="dd/mm/yyyy"
        timePlaceholder="hh:mm"
        description={`Giờ tính theo múi giờ máy bạn (${zone}). Hẹn được trong vòng ${MAX_SCHEDULE_AHEAD_DAYS} ngày, và phải là thời điểm trong tương lai.`}
        status={error ? { type: "error", message: error } : undefined}
      />

      {verdict?.ok ? (
        // `role="status"`: the sentence changes as the operator picks, and a
        // screen-reader user should hear the result of their own choice.
        <Text type="supporting" role="status" aria-live="polite">
          Sẽ đăng lúc {formatScheduledAt(verdict.iso)} ({zone}) — {formatCountdown(verdict.delayMs)}.
        </Text>
      ) : null}
    </VStack>
  );
}
