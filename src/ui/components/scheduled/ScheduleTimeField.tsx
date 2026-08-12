"use client";

import { Input } from "@/ui/components/ui/input";
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
 * Native `<input type="datetime-local">` on purpose (web-form-inputs rule 5):
 * the operator can TYPE the time, the mobile keyboard is the right one, and the
 * value is local wall time — which is exactly what "đăng lúc 20h" means. A
 * hand-built picker would cost all three and buy nothing here.
 *
 * The window is stated BEFORE a choice is made (core-booking-scheduling rule 5):
 * `min`/`max` on the field, and the same sentence in the hint for anyone whose
 * browser ignores them. The client check is a courtesy — the server re-validates
 * and has the final say.
 */
export function ScheduleTimeField({
  id,
  label,
  value,
  onChange,
  disabled,
  error,
  nowMs,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  /** Message from the last submit attempt or from the server. */
  error?: string | null;
  /** 0 before the browser clock is known — the preview then stays quiet. */
  nowMs: number;
}) {
  const zone = timeZoneLabel();
  const bounds = nowMs > 0 ? scheduleInputBounds(nowMs) : null;
  const verdict = nowMs > 0 && value.trim().length > 0 ? validateScheduleInput(value, nowMs) : null;
  const hintId = `${id}-hint`;
  const previewId = `${id}-preview`;
  const errorId = `${id}-error`;

  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <Input
        id={id}
        type="datetime-local"
        value={value}
        step={60}
        min={bounds?.min}
        max={bounds?.max}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={`${hintId}${verdict?.ok ? ` ${previewId}` : ""}${error ? ` ${errorId}` : ""}`}
        className="max-w-xs"
      />
      <p id={hintId} className="text-muted-foreground text-xs">
        Giờ tính theo múi giờ máy bạn ({zone}). Hẹn được trong vòng{" "}
        {MAX_SCHEDULE_AHEAD_DAYS} ngày, và phải là thời điểm trong tương lai.
      </p>

      {verdict?.ok ? (
        <p id={previewId} className="text-sm">
          Sẽ đăng lúc{" "}
          <span className="font-medium">{formatScheduledAt(verdict.iso)}</span> ({zone}) —{" "}
          {formatCountdown(verdict.delayMs)}.
        </p>
      ) : null}

      {error ? (
        <p id={errorId} role="alert" className="text-destructive text-sm">
          {error}
        </p>
      ) : null}
    </div>
  );
}
