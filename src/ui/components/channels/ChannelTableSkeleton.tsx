"use client";

import { HStack, Skeleton, Stack } from "@astryxdesign/core";

/** Column widths mirror ChannelTable so the real rows land where these sat. */
const COLUMNS = [130, null, 190, 110, 170, 280] as const;
const ROWS = 5;

/**
 * Loading placeholder for the connected Pages. Shaped like the real table —
 * same column widths, same row height — so nothing jumps when the data lands
 * (web-feedback-states §1: a skeleton that does not match is worse than none).
 */
export function ChannelTableSkeleton() {
  return (
    <Stack direction="vertical" gap={0} padding={0} aria-hidden="true">
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
