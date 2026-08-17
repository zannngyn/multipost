import * as React from "react";

import { cn } from "@/shared/utils";

/**
 * The small mono label above a heading ("BƯỚC 1 / 3", "TIẾN TRÌNH").
 *
 * Presentational and deliberately not a heading: it labels the block that
 * follows it, so putting it in the heading outline would give a screen reader a
 * second, redundant title for the same section.
 */
function Eyebrow({ className, ...props }: React.ComponentProps<"p">) {
  return (
    <p
      data-slot="eyebrow"
      className={cn(
        "text-foreground-subtle font-mono text-xs tracking-widest uppercase",
        className,
      )}
      {...props}
    />
  );
}

export { Eyebrow };
