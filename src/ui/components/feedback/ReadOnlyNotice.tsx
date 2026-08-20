import { cn } from "@/shared/utils";

/**
 * Why a write control next to it is off (M3.3).
 *
 * A visible line rather than a tooltip on purpose: these screens use the local
 * button primitive, which has no tooltip slot, and a tooltip would be invisible
 * on touch and awkward on a keyboard. A disabled control that cannot explain
 * itself is the thing core-auth-session forbids.
 *
 * `role="status"`: it appears when the session changes, and a screen-reader
 * user who cannot see the greyed-out button needs to hear why it is grey. Not
 * `alert` — nothing is wrong, and nothing is interrupting.
 *
 * Renders nothing at all when there is no reason, so a normal session is not
 * changed by one pixel.
 */
export function ReadOnlyNotice({
  reason,
  className,
}: {
  reason: string | null;
  className?: string;
}) {
  if (!reason) return null;

  return (
    <p role="status" className={cn("text-muted-foreground max-w-prose text-sm", className)}>
      {reason}
    </p>
  );
}
