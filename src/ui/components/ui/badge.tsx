import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/shared/utils";

/**
 * Status pill. Presentational only — every colour comes from the design tokens
 * in globals.css, never from a literal hex (core-design-tokens).
 *
 * Tone is chosen by the CALLER from the domain status, so the mapping stays in
 * one readable place per screen instead of being hidden in here.
 */
const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium whitespace-nowrap",
  {
    variants: {
      tone: {
        neutral: "border-border bg-muted text-muted-foreground",
        success: "border-success/30 bg-success/10 text-success-foreground",
        warning: "border-warning/40 bg-warning/10 text-warning-foreground",
        danger: "border-destructive/30 bg-destructive/10 text-destructive",
        // Same tint + hairline + readable-tone recipe as the three above. It
        // used to be a bare outline, which made `info` look like "no tone at
        // all" next to its siblings, and left the `--info` token pair that
        // globals.css introduced for these pills unused.
        info: "border-info/30 bg-info/10 text-info-foreground",
      },
    },
    defaultVariants: { tone: "neutral" },
  },
);

export type BadgeTone = NonNullable<VariantProps<typeof badgeVariants>["tone"]>;

function Badge({
  className,
  tone,
  ...props
}: React.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return <span data-slot="badge" className={cn(badgeVariants({ tone, className }))} {...props} />;
}

export { Badge, badgeVariants };
