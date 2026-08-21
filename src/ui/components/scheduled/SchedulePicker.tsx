"use client";

import { useId } from "react";

import { cn } from "@/shared/utils";
import { ScheduleTimeField } from "@/ui/components/scheduled/ScheduleTimeField";
import { useNowMs } from "@/ui/hooks/useNowMs";
import type { ScheduleChoice } from "@/ui/hooks/useScheduleChoice";

/**
 * "Đăng ngay" / "Hẹn giờ đăng" (E8.1 UI) — one control, used by the compose
 * wizard (step 3) and by the bulk screen (core-component-reuse).
 *
 * Radios, not a switch: two named options make the default visible. "Đăng ngay"
 * is preselected, and the scheduled branch only appears once it is chosen —
 * nothing on screen while it is irrelevant.
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
    <fieldset className="flex flex-col gap-2.5" aria-describedby={`${groupId}-hint`}>
      <legend className="text-sm font-medium">Thời điểm đăng</legend>
      <p id={`${groupId}-hint`} className="text-muted-foreground text-xs leading-relaxed">
        {scopeNote}
      </p>

      {(
        [
          {
            mode: "now" as const,
            label: "Đăng ngay",
            hint: "Bài vào hàng đợi ngay khi tạo lô; các kênh vẫn được đăng giãn cách theo cấu hình.",
          },
          {
            mode: "scheduled" as const,
            label: "Hẹn giờ đăng",
            hint: "Bài chờ tới giờ đã hẹn. Trước khi tới giờ vẫn đổi giờ hoặc huỷ được ở màn “Bài đã hẹn”.",
          },
        ] as const
      ).map((option) => (
        <label
          key={option.mode}
          className={cn(
            "bg-card border-border has-checked:border-primary has-checked:bg-accent/20 has-checked:ring-primary flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition-colors has-checked:ring-1",
            "has-focus-visible:ring-ring/50 has-focus-visible:ring-3",
          )}
        >
          <input
            type="radio"
            name={groupId}
            value={option.mode}
            className="peer sr-only"
            checked={choice.mode === option.mode}
            disabled={disabled}
            onChange={() => choice.setMode(option.mode)}
          />
          <span
            aria-hidden="true"
            className="border-input peer-checked:border-primary mt-0.5 size-4 shrink-0 rounded-full border-2 transition-colors peer-checked:bg-primary"
          />
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="text-sm font-medium">{option.label}</span>
            <span className="text-muted-foreground text-xs leading-relaxed">{option.hint}</span>
          </span>
        </label>
      ))}

      {choice.mode === "scheduled" ? (
        <div className="bg-accent/15 flex flex-col gap-2.5 rounded-xl p-3.5">
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
            <div role="group" aria-label="Giờ đăng gợi ý" className="flex flex-wrap gap-1.5">
              {slots.map((slot) => (
                <button
                  key={slot.value}
                  type="button"
                  disabled={disabled}
                  aria-pressed={choice.value === slot.value}
                  onClick={() => choice.setValue(slot.value)}
                  className={cn(
                    "focus-visible:ring-ring/50 cursor-pointer rounded-full px-3 py-1 text-xs transition-colors outline-none focus-visible:ring-3 disabled:opacity-50",
                    choice.value === slot.value
                      ? "bg-primary text-primary-foreground"
                      : "bg-card text-accent-foreground hover:bg-accent/40",
                  )}
                >
                  {slot.label}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </fieldset>
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

/** `<input type="datetime-local">` wants LOCAL wall time, so never touch toISOString(). */
function toDateTimeLocal(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
