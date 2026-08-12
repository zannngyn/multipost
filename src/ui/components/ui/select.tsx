import * as React from "react";

import { cn } from "@/shared/utils";

/**
 * Native `<select>` primitive, matching the Input token set.
 *
 * Native on purpose (core-form-inputs): a status filter is a short list of
 * fixed options — the browser control is keyboard-accessible, screen-reader
 * correct and works on a phone with zero JavaScript. A custom listbox would
 * only add weight and a11y risk here.
 */
function Select({ className, children, ...props }: React.ComponentProps<"select">) {
  return (
    <select
      data-slot="select"
      className={cn(
        "border-input bg-background flex h-9 w-full rounded-lg border px-3 py-1 text-sm shadow-xs transition-colors outline-none",
        "focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-3",
        "disabled:cursor-not-allowed disabled:opacity-50",
        "aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40",
        className,
      )}
      {...props}
    >
      {children}
    </select>
  );
}

export { Select };
