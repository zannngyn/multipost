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
 * value is local wall time — which is exactly what "đăng lúc 20h" means.
 *
 * WHY NOT A COMPONENT-LIBRARY PICKER. This field was briefly swapped to Astryx
 * `DateTimeInput`, which parses a typed date string instead of using segments.
 * Measured against that parser (`utils/dateParser.ts`), two defects land
 * squarely on Vietnamese operators:
 *
 *   1. It picks day-vs-month order by HEURISTIC — the number above 12 wins —
 *      and falls back to the CLIENT's locale when both are ≤ 12. On a machine
 *      left at en-US, "1/9/2026" is read as 9 January: no error, no red field,
 *      just a batch scheduled eight months early. Roughly 40% of the days in a
 *      year are ambiguous that way, and business rule 5 forbids exactly this
 *      kind of silent wrong answer.
 *   2. On a machine set to Vietnamese it renders the chosen value as
 *      "15 tháng 9, 2026" and then cannot re-parse its own output, so editing
 *      the field by keyboard marks it invalid and silently reverts on blur.
 *
 * `DateTimeInput` exposes no `format`/`locale`/`parse` prop to correct either.
 * The native control has neither problem: the browser renders segments in the
 * OS locale (dd/mm/yyyy on a Vietnamese machine), typing digits advances
 * between segments, and no free-text date string is ever parsed.
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
   * WHY the field is locked. Rendered as VISIBLE text beside the field, not as
   * a tooltip: a disabled native control swallows hover, so a tooltip would be
   * mouse-only — and invisible to the keyboard user who most needs the reason.
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
  // to the validator as if it were a datetime.
  const trimmed = typeof value === "string" ? value.trim() : "";
  const verdict = nowMs > 0 && trimmed.length > 0 ? validateScheduleInput(trimmed, nowMs) : null;

  const hintId = `${id}-hint`;
  const previewId = `${id}-preview`;
  const errorId = `${id}-error`;
  const lockedId = `${id}-locked`;
  const showLocked = Boolean(disabled && disabledReason);

  return (
    <div className="max-w-xs space-y-1.5">
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
        aria-describedby={
          `${hintId}` +
          `${showLocked ? ` ${lockedId}` : ""}` +
          `${verdict?.ok ? ` ${previewId}` : ""}` +
          `${error ? ` ${errorId}` : ""}`
        }
      />

      {showLocked ? (
        <p id={lockedId} className="text-muted-foreground text-xs">
          {disabledReason}
        </p>
      ) : null}

      <p id={hintId} className="text-muted-foreground text-xs">
        Giờ tính theo múi giờ máy bạn ({zone}). Hẹn được trong vòng {MAX_SCHEDULE_AHEAD_DAYS} ngày,
        và phải là thời điểm trong tương lai.
      </p>

      {verdict?.ok ? (
        // `role="status"`: the sentence changes as the operator picks, and a
        // screen-reader user should hear the result of their own choice.
        <p id={previewId} role="status" aria-live="polite" className="text-sm">
          Sẽ đăng lúc <span className="font-medium">{formatScheduledAt(verdict.iso)}</span> ({zone}){" "}
          — {formatCountdown(verdict.delayMs)}.
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
