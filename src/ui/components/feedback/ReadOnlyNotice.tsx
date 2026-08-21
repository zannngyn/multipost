import { Icon, Stack, Text } from "@astryxdesign/core";
import { Lock } from "lucide-react";

import { cn } from "@/shared/utils";

/**
 * Why a write control next to it is off (M3.3).
 *
 * A visible line rather than a tooltip on purpose: a tooltip would be invisible
 * on touch and awkward on a keyboard, and a disabled control that cannot explain
 * itself is the thing core-auth-session forbids.
 *
 * The padlock is decorative — the sentence next to it carries the meaning — but
 * it gives the line a shape the eye finds next to a greyed-out button, instead
 * of one more grey sentence on the screen.
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
    <Stack
      role="status"
      direction="horizontal"
      gap={1.5}
      align="start"
      className={cn("max-w-prose", className)}
    >
      <Icon icon={Lock} size="sm" color="secondary" />
      <Text type="supporting" as="span">
        {reason}
      </Text>
    </Stack>
  );
}
