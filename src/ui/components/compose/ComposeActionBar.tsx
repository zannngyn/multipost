"use client";

import { cn } from "@/shared/utils";

/**
 * The action row of the compose screen:
 *
 *   [Chọn kênh]  |  [Đăng luôn]  [Hẹn lịch]              N kênh · 1 bài
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
    <div className="flex flex-wrap items-center gap-3.5">
      <button
        type="button"
        onClick={onPickChannels}
        className="focus-visible:ring-ring bg-card h-13 cursor-pointer rounded-lg px-6 text-[15px] font-medium shadow-[inset_0_0_0_1px_var(--input)] outline-none focus-visible:ring-3"
      >
        Chọn kênh
      </button>

      <span aria-hidden="true" className="h-6.5 w-px bg-[var(--border)]" />

      <button
        type="button"
        onClick={onPrimary}
        disabled={primaryDisabled || blocked}
        aria-busy={busy}
        title={readOnlyReason ?? undefined}
        className={cn(
          "focus-visible:ring-ring h-13 cursor-pointer rounded-lg bg-primary text-primary-foreground px-8 text-[15px] font-semibold outline-none focus-visible:ring-3",
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
        title={readOnlyReason ?? undefined}
        className={cn(
          "focus-visible:ring-ring h-13 cursor-pointer rounded-lg px-6 text-[15px] font-medium outline-none focus-visible:ring-3",
          scheduling
            ? "bg-accent text-accent-foreground shadow-[inset_0_0_0_1.5px_var(--primary)]"
            : "bg-card shadow-[inset_0_0_0_1px_var(--input)]",
          "disabled:cursor-not-allowed disabled:opacity-50",
        )}
      >
        Hẹn lịch
      </button>

      <span className="flex-1" />

      <p className="text-muted-foreground max-w-90 text-[13px] leading-relaxed">{note}</p>
    </div>
  );
}
