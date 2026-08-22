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
 *
 * NO WIDTH OF ITS OWN, on purpose. It used to hardcode `max-w-prose`, which
 * looks harmless and is not: `max-width` clamps the USED flex base size, so a
 * caller putting it in a flex row with `basis-full` — asking it to take a line
 * of its own under the buttons it explains — got a 65ch item that still fitted
 * beside them and read as a third button's label. A component cannot know the
 * box it is dropped into; the call site can, and now says so. Callers that want
 * a reading measure pass `max-w-prose` themselves.
 */
export function ReadOnlyNotice({
  reason,
  className,
}: {
  reason: string | null;
  /** Width and type scale belong to the caller — see the note above. */
  className?: string;
}) {
  if (!reason) return null;

  return (
    <p role="status" className={cn("text-muted-foreground text-sm", className)}>
      {reason}
    </p>
  );
}
