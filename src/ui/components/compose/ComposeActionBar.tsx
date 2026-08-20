"use client";

import { cn } from "@/shared/utils";

/**
 * The bar at the foot of the left card — template lines 126–132:
 *
 *   [Chọn kênh]  |  [Đăng luôn]  [Hẹn lịch]              N kênh · 1 bài
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
    <div className="flex flex-wrap items-center gap-3.5 pt-4 shadow-[inset_0_1px_0_var(--compose-hairline)]">
      <button
        type="button"
        onClick={onPickChannels}
        className="focus-visible:ring-ring h-13 cursor-pointer rounded-[var(--compose-radius-control)] bg-[var(--card)] px-6 text-[15px] font-medium shadow-[inset_0_0_0_1px_var(--compose-hairline-strong)] outline-none focus-visible:ring-3"
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
          "focus-visible:ring-ring h-13 cursor-pointer rounded-[var(--compose-radius-control)] bg-[var(--compose-ink)] px-8 text-[15px] font-semibold text-[var(--card)] outline-none focus-visible:ring-3",
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
          "focus-visible:ring-ring h-13 cursor-pointer rounded-[var(--compose-radius-control)] px-6 text-[15px] font-medium outline-none focus-visible:ring-3",
          scheduling
            ? "bg-[var(--compose-chip-on)] shadow-[inset_0_0_0_1.5px_var(--compose-chip-ring)]"
            : "bg-[var(--card)] shadow-[inset_0_0_0_1px_var(--compose-hairline-strong)]",
          "disabled:cursor-not-allowed disabled:opacity-50",
        )}
      >
        Hẹn lịch
      </button>

      <span className="flex-1" />

      <p className="text-[13px] text-[var(--muted-foreground)]">{note}</p>
    </div>
  );
}
