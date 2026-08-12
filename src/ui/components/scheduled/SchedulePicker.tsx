"use client";

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
  scopeNote,
}: {
  choice: ScheduleChoice;
  disabled?: boolean;
  /** What "mọi kênh" means on this screen (one post vs a whole run). */
  scopeNote: string;
}) {
  const groupId = useId();
  const fieldId = `${groupId}-at`;
  const nowMs = useNowMs();

  return (
    <fieldset className="space-y-3" aria-describedby={`${groupId}-hint`}>
      <legend className="text-sm font-medium">Thời điểm đăng</legend>
      <p id={`${groupId}-hint`} className="text-muted-foreground text-xs">
        {scopeNote}
      </p>

      <label className="flex items-start gap-2 text-sm">
        <input
          type="radio"
          name={groupId}
          value="now"
          className="accent-primary mt-0.5 size-4"
          checked={choice.mode === "now"}
          disabled={disabled}
          onChange={() => choice.setMode("now")}
        />
        <span>
          Đăng ngay
          <span className="text-muted-foreground block text-xs">
            Bài vào hàng đợi ngay khi tạo lô; các kênh vẫn được đăng giãn cách theo cấu hình.
          </span>
        </span>
      </label>

      <label className="flex items-start gap-2 text-sm">
        <input
          type="radio"
          name={groupId}
          value="scheduled"
          className="accent-primary mt-0.5 size-4"
          checked={choice.mode === "scheduled"}
          disabled={disabled}
          onChange={() => choice.setMode("scheduled")}
        />
        <span>
          Hẹn giờ đăng
          <span className="text-muted-foreground block text-xs">
            Bài chờ tới giờ đã hẹn. Trước khi tới giờ vẫn đổi giờ hoặc huỷ được ở màn “Bài đã hẹn”.
          </span>
        </span>
      </label>

      {choice.mode === "scheduled" ? (
        <ScheduleTimeField
          id={fieldId}
          label="Giờ đăng"
          value={choice.value}
          onChange={choice.setValue}
          disabled={disabled}
          error={choice.error}
          nowMs={nowMs}
        />
      ) : null}
    </fieldset>
  );
}
