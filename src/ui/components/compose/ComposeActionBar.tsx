"use client";

import { CalendarClock } from "lucide-react";

import { cn } from "@/shared/utils";

/**
 * The action row of the compose screen:
 *
 *   [Chọn kênh]  |  [Đăng luôn]  [Hẹn lịch]              N kênh · 1 bài
 *
 * On a narrow container the three buttons stay on ONE row and the note drops
 * to its own line under them (`@sm` is measured on the compose container, so a
 * phone is always below it). The bug that forced this: the row wrapped to two
 * lines and the second line landed on top of the note, so the sentence saying
 * WHY the button was dim was unreadable exactly where it mattered. "Hẹn lịch"
 * gives up its label first — it is the secondary branch, and it keeps the name
 * as `aria-label` plus a tooltip.
 *
 * It renders inside the sticky tray at the foot of the left column, so the one
 * action and the sentence explaining it are on screen at every scroll position
 * of a card that is several viewports tall. The tray — its background, its
 * hairline, and the schedule fields that open above this row — belongs to
 * `ComposeFocus`; this component is the row and nothing else.
 *
 * One black action, because there is one thing this screen does. The wizard's
 * "Tiếp / Quay lại" pair is gone with the wizard: nothing on this screen is a
 * step, so nothing needs a next.
 *
 * `note` is not decoration. Whenever the action is unavailable it says WHY, in
 * the same place the button is dimmed — a dead button with no sentence beside
 * it is the thing this bar exists to avoid (core-feedback-states §công thức
 * viết thông báo). When the action IS available it counts what is about to
 * happen, so nobody publishes to eight pages thinking it was one.
 */
export function ComposeActionBar({
  onPublishNow,
  onSchedule,
  primaryDisabled,
  note,
  busy,
  readOnlyReason,
}: {
  onPublishNow: () => void;
  onSchedule: () => void;
  primaryDisabled: boolean;
  note: string;
  busy: boolean;
  /**
   * Support mode (M3.3): every write answers 403, so both write actions are
   * disabled and the reason is already in `note`.
   */
  readOnlyReason?: string | null;
}) {
  const blocked = Boolean(readOnlyReason);
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
      <div className="flex flex-wrap items-center gap-2.5">
        {/* Nút Đăng ngay (Primary) */}
        <button
          type="button"
          onClick={onPublishNow}
          disabled={primaryDisabled || blocked}
          aria-busy={busy}
          title={readOnlyReason ?? undefined}
          className={cn(
            "flex h-11 cursor-pointer items-center gap-2 rounded-xl bg-primary px-6 text-xs font-bold text-primary-foreground shadow-xs transition-all hover:opacity-90 outline-none focus:ring-2 focus:ring-primary/30",
            "disabled:cursor-not-allowed disabled:opacity-40",
          )}
        >
          <span>Đăng ngay</span>
        </button>

        {/* Nút Hẹn lịch (Secondary Action) */}
        <button
          type="button"
          onClick={onSchedule}
          disabled={primaryDisabled || blocked}
          aria-busy={busy}
          title={readOnlyReason ?? "Mở bảng chọn ngày giờ hẹn đăng"}
          className={cn(
            "flex h-11 cursor-pointer items-center gap-2 rounded-xl border border-input bg-card px-4 text-xs font-semibold text-foreground shadow-xs transition-all hover:bg-muted/50 outline-none focus:ring-2 focus:ring-primary/20",
            "disabled:cursor-not-allowed disabled:opacity-40",
          )}
        >
          <CalendarClock className="size-4 text-primary shrink-0" />
          <span>Hẹn lịch</span>
        </button>
      </div>

      {/* Note indicator on the right */}
      <p className="text-muted-foreground text-xs font-medium leading-relaxed">
        {note}
      </p>
    </div>
  );
}

