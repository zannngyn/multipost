"use client";

import { HStack, Skeleton, Stack } from "@astryxdesign/core";

/** Column widths mirror AccessRequestTable so the real rows land where these sat. */
const COLUMNS = [140, null, 140, 170, 130, 170, null, 420] as const;
const ROWS = 5;

/**
 * Loading placeholder for the access requests. Shaped like the real table —
 * same column widths, same row height — so nothing jumps when the data lands
 * (web-feedback-states §1: a skeleton that does not match is worse than none).
 */
export function AccessRequestTableSkeleton() {
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
