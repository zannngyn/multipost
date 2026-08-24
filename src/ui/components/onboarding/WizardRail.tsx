"use client";

import { Check } from "lucide-react";

import { cn } from "@/shared/utils";
import { JoinInviteForm } from "@/ui/components/tenant/JoinInviteForm";

/**
 * The dark column of the first-run wizard: where you are, and the two ways out.
 *
 * It carries the ONLY two escapes from a `purpose="required"` dialog, and both
 * are load-bearing rather than decorative:
 *
 *   1. "Đã có người mời bạn?" — an employee whose admin already sent them a
 *      link must not be made to found a second company to get past this screen.
 *   2. "Đăng xuất" — the dialog blocks the top bar, sign-out included. Without
 *      this line an account with no company is locked in the browser with no
 *      way back to the sign-in screen (spec §8).
 *
 * On a narrow viewport this becomes a header band above the panes rather than
 * a column beside them — a 2-column dialog on a phone is two unusable columns.
 */

export interface RailMilestone {
  readonly label: string;
  readonly detail: string;
  readonly state: "done" | "current" | "upcoming";
}

export function WizardRail({
  milestones,
  join,
  onSignOut,
}: {
  milestones: readonly RailMilestone[];
  join: {
    readonly onSubmit: (values: { invite: string }) => void;
    readonly isPending: boolean;
    readonly error: unknown;
  };
  /**
   * A Server Action handed down from the layout. This component sits in
   * `src/ui`, which may not import `src/app` (docs/07) — receiving the action
   * as a prop is how the shell already does it (`AppSideNav.onSignOut`).
   *
   * Absent only in the dev preview, where there is no session to end.
   */
  onSignOut?: () => Promise<void>;
}) {
  return (
    <aside className="bg-foreground text-background flex flex-col gap-6 p-6 md:w-[19rem] md:shrink-0">
      <div>
        <p className="font-mono text-sm font-semibold tracking-[0.14em]">MYSP</p>
        <p className="text-background/65 mt-4 text-[13px] leading-relaxed">
          Dữ liệu trong MYSP luôn thuộc về một công ty. Tạo công ty rồi mời người vào là xong phần
          khung — hai phút.
        </p>
      </div>

      <ol className="flex flex-col">
        {milestones.map((milestone, index) => {
          const isLast = index === milestones.length - 1;
          return (
            <li key={milestone.label} className="flex gap-3">
              {/* Marker column: the dot, and the thread joining it to the next */}
              <div className="flex flex-col items-center">
                <span
                  aria-hidden="true"
                  className={cn(
                    "grid size-5 shrink-0 place-items-center rounded-full border-2",
                    "motion-safe:transition-colors motion-safe:duration-300",
                    milestone.state === "done" && "bg-warning border-warning text-foreground",
                    milestone.state === "current" && "border-warning text-warning",
                    milestone.state === "upcoming" && "border-background/30",
                  )}
                >
                  {milestone.state === "done" ? (
                    <Check className="size-3" strokeWidth={3} />
                  ) : milestone.state === "current" ? (
                    <span className="bg-warning size-1.5 rounded-full" />
                  ) : null}
                </span>
                {!isLast ? <span className="bg-background/20 my-1 w-px flex-1" aria-hidden="true" /> : null}
              </div>

              <div className={cn("min-w-0", !isLast && "pb-5")}>
                <p
                  className={cn(
                    "text-[13px]",
                    milestone.state === "upcoming" ? "text-background/60" : "text-background",
                  )}
                >
                  {milestone.label}
                </p>
                <p className="text-background/45 mt-0.5 truncate text-xs">{milestone.detail}</p>
              </div>
            </li>
          );
        })}
      </ol>

      {/* Escape 1 — the invited employee. `mt-auto` on wide viewports only:
          stacked on a phone this sits directly under the milestones instead of
          being pushed to the bottom of a column that no longer exists. */}
      <div className="border-background/15 bg-background/[0.06] rounded-lg border p-3.5 md:mt-auto">
        <p className="text-[13px] font-semibold">Đã có người mời bạn?</p>
        <p className="text-background/55 mt-1 mb-2.5 text-xs leading-relaxed">
          Dán link mời để vào công ty của họ.
        </p>
        {/* The dark surface is a local inversion, so the form's own tokens are
            re-pointed here rather than the component being forked. */}
        <div className="[&_input]:bg-background/10 [&_input]:border-background/25 [&_input]:text-background [&_input]:placeholder:text-background/40 [&_label]:text-background/70 [&_p]:text-background/50">
          <JoinInviteForm
            onSubmit={join.onSubmit}
            isPending={join.isPending}
            error={join.error}
          />
        </div>
      </div>

      {/* Escape 2 — the way out of a dialog that blocks the top bar. */}
      {onSignOut ? (
        <form action={onSignOut}>
          <button
            type="submit"
            className="text-background/50 hover:text-background focus-visible:ring-warning/60 rounded text-xs underline underline-offset-4 outline-none focus-visible:ring-2"
          >
            Đăng xuất
          </button>
        </form>
      ) : null}
    </aside>
  );
}
