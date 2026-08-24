"use client";

import { HStack, Skeleton, Stack } from "@astryxdesign/core";

/** Column widths mirror PlatformTenantTable so real rows land where these sat. */
const COLUMNS = [null, 130, 150, 120, 170, 420] as const;
const ROWS = 4;

/**
 * Loading placeholder for the company list. Shaped like the real table — same
 * column widths, same row height — so nothing jumps when the data lands
 * (web-feedback-states §1: a skeleton that does not match is worse than none).
 */
export function PlatformTenantTableSkeleton() {
  return (
    // `paddingInline={4}`: the real table now stands in the screen's 16px
    // column (see PlatformScreen), and a skeleton on a different edge is the
    // jump this component exists to prevent.
    <Stack direction="vertical" gap={0} paddingBlock={0} paddingInline={4} aria-hidden="true">
      {Array.from({ length: ROWS }, (_, row) => (
        <HStack key={row} gap={3} padding={3} align="center">
          {COLUMNS.map((width, column) => (
            <Skeleton key={column} width={width ?? "100%"} height={16} index={row} />
          ))}
        </HStack>
      ))}
    </Stack>
  );
}
