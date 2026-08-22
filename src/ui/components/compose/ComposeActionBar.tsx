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
  primaryLabel,
  onPrimary,
  primaryDisabled,
  scheduling,
  onToggleSchedule,
  onPickChannels,
  note,
  busy,
  readOnlyReason,
}: {
  primaryLabel: string;
  onPrimary: () => void;
  primaryDisabled: boolean;
  /** True when the schedule branch is chosen — the "Hẹn lịch" toggle's state. */
  scheduling: boolean;
  onToggleSchedule: () => void;
  onPickChannels: () => void;
  note: string;
  busy: boolean;
  /**
   * Support mode (M3.3): every write answers 403, so both write actions are
   * disabled and the reason is already in `note`. Choosing channels stays
   * available — it changes nothing on the server.
   */
  readOnlyReason?: string | null;
}) {
  const blocked = Boolean(readOnlyReason);
  return (
    // No frame of its own any more: the bar is the last row of the sticky tray
    // its caller owns, and a second hairline inside that tray only drew a line
    // across it. Spacing and background belong to the tray, this is the row.
    <div className="flex flex-wrap items-center gap-2.5 @sm:gap-3.5">
      <button
        type="button"
        onClick={onPickChannels}
        className="focus-visible:ring-ring bg-card h-13 cursor-pointer rounded-lg px-4 text-[15px] font-medium shadow-[inset_0_0_0_1px_var(--input)] outline-none focus-visible:ring-3 @sm:px-6"
      >
        Chọn kênh
      </button>

      {/* The rule between "choose" and "publish". Dropped on a narrow row:
          three buttons already fill it, and the gap says the same thing. */}
      <span aria-hidden="true" className="hidden h-6.5 w-px bg-[var(--border)] @sm:block" />

      <button
        type="button"
        onClick={onPrimary}
        disabled={primaryDisabled || blocked}
        aria-busy={busy}
        title={readOnlyReason ?? undefined}
        className={cn(
          // Takes the room the row has left on a phone, keeps its own width
          // from @sm up — it is the one thing this screen does.
          "focus-visible:ring-ring h-13 flex-1 cursor-pointer rounded-lg bg-primary text-primary-foreground px-4 text-[15px] font-semibold outline-none focus-visible:ring-3 @sm:flex-none @sm:px-8",
          "disabled:cursor-not-allowed disabled:opacity-50",
        )}
      >
        {primaryLabel}
      </button>

      <button
        type="button"
        aria-pressed={scheduling}
        onClick={onToggleSchedule}
        disabled={blocked}
        // Named for the narrow row, where the label is an icon. Same words as
        // the visible label above @sm, so voice control matches what is drawn.
        aria-label="Hẹn lịch"
        title={readOnlyReason ?? "Hẹn lịch"}
        className={cn(
          "focus-visible:ring-ring h-13 w-13 shrink-0 cursor-pointer rounded-lg text-[15px] font-medium outline-none focus-visible:ring-3 @sm:w-auto @sm:px-6",
          scheduling
            ? "bg-accent text-accent-foreground shadow-[inset_0_0_0_1.5px_var(--primary)]"
            : "bg-card shadow-[inset_0_0_0_1px_var(--input)]",
          "disabled:cursor-not-allowed disabled:opacity-50",
        )}
      >
        <CalendarClock aria-hidden="true" className="mx-auto size-5 @sm:hidden" />
        <span className="hidden @sm:inline">Hẹn lịch</span>
      </button>

      <span aria-hidden="true" className="hidden flex-1 @sm:block" />

      {/* Its own line on a phone (`w-full`), beside the buttons from @sm up.
          It must never share a line with a wrapped button: this sentence is
          the reason a dimmed button is refusing. */}
      <p className="text-muted-foreground w-full text-[13px] leading-relaxed @sm:w-auto @sm:max-w-90">
        {note}
      </p>
    </div>
  );
}
