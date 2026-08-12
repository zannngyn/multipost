import * as React from "react";

import { cn } from "@/shared/utils";

/**
 * Multiline text primitive, matching the Input token set (border, focus ring,
 * invalid state) so a form does not look assembled from two design systems.
 */
function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "border-input bg-background placeholder:text-muted-foreground field-sizing-content flex min-h-24 w-full rounded-lg border px-3 py-2 text-sm shadow-xs transition-colors outline-none",
        "focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-3",
        "disabled:cursor-not-allowed disabled:opacity-50",
        "aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40",
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
