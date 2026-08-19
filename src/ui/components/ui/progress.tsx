import * as React from "react";

import { cn } from "@/shared/utils";

/**
 * Progress bar primitive. Presentational only — every colour comes from the
 * design tokens in globals.css (core-design-tokens).
 *
 * [L6-New] Search-Before-Create: `role="progressbar"` / `aria-valuenow` appear
 * nowhere in `src/ui/**`, and the only bar-shaped thing in the repo is the
 * upload queue's own markup, which is a list of files, not a meter.
 *
 * TWO MODES, and the difference is a promise to the operator:
 *  - `value` a number  -> determinate: something real was counted.
 *  - `value` null      -> indeterminate: the step is running and nothing
 *    countable is known. ARIA says so by OMITTING `aria-valuenow` (the spec's
 *    own signal for an indeterminate bar), and the fill is a soft full-width
 *    wash rather than a partial one, so nobody reads a percentage into it.
 */
export interface ProgressProps extends Omit<React.ComponentProps<"div">, "children"> {
  /** Null = indeterminate. A number is only ever passed when it was measured. */
  value: number | null;
  max?: number;
  /** Accessible name — a bar without one is an unlabelled meter. */
  label: string;
  /** What the bar means, in Vietnamese; read instead of the bare number. */
  valueText: string;
}

export function Progress({ value, max = 100, label, valueText, className, ...rest }: ProgressProps) {
  const determinate = typeof value === "number" && Number.isFinite(value) && max > 0;
  const percent = determinate ? clampPercent((value / max) * 100) : 0;

  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={determinate ? 0 : undefined}
      aria-valuemax={determinate ? max : undefined}
      aria-valuenow={determinate ? value : undefined}
      aria-valuetext={valueText}
      className={cn("bg-muted h-1.5 w-full overflow-hidden rounded-full", className)}
      {...rest}
    >
      <span
        aria-hidden="true"
        className={cn(
          "bg-primary block h-full rounded-full",
          determinate
            ? "motion-safe:transition-[width] motion-safe:duration-300"
            : // Full width at low opacity + a pulse: "đang chạy, chưa đếm được".
              // A partial width here would be a percentage nobody measured.
              "w-full opacity-40 motion-safe:animate-pulse",
        )}
        // Data, not design: the width IS the measured value, so it cannot come
        // from the spacing scale (core-design-tokens §giá trị dùng một lần).
        style={determinate ? { width: `${percent}%` } : undefined}
      />
    </div>
  );
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, Math.round(value)));
}
