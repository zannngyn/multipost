"use client";

import { Grid, HStack, Skeleton, Stack } from "@astryxdesign/core";

/**
 * Skeleton shaped like the real batch screen: the same summary block with six
 * counters, the same four table columns and row height — a skeleton of the
 * wrong shape is just a layout shift with extra steps (web-feedback-states /
 * web-data-table rule 1).
 *
 * `aria-hidden`: a screen reader gains nothing from grey boxes — the live region
 * in the screen announces "đang tải".
 */

/** Mirrors BatchChannelTable's column widths. */
const COLUMNS = [220, 180, 104, null] as const;

export function BatchStatusSkeleton() {
  return (
    <Stack direction="vertical" gap={6} aria-hidden="true">
      <Stack direction="vertical" gap={4}>
        <Stack direction="vertical" gap={2}>
          <HStack gap={2} align="center">
            <Skeleton width={120} height={20} />
            <Skeleton width={96} height={16} />
          </HStack>
          <Skeleton width="100%" height={16} />
        </Stack>

        <Grid columns={{ minWidth: 132, max: 6 }} gap={4}>
          {[0, 1, 2, 3, 4, 5].map((cell) => (
            <Stack key={cell} direction="vertical" gap={1}>
              <Skeleton width={40} height={28} index={cell} />
              <Skeleton width={88} height={12} index={cell} />
            </Stack>
          ))}
        </Grid>

        <Grid columns={2} gap={3}>
          {[0, 1, 2, 3].map((row) => (
            <HStack key={row} gap={3} align="center">
              <Skeleton width={112} height={12} />
              <Skeleton width="100%" height={12} />
            </HStack>
          ))}
        </Grid>
      </Stack>

      <Stack direction="vertical" gap={3}>
        <Skeleton width={200} height={20} />
        <Stack direction="vertical" gap={0}>
          {[0, 1, 2].map((row) => (
            <HStack key={row} gap={3} padding={3} align="center">
              {COLUMNS.map((width, column) => (
                <Skeleton key={column} width={width ?? "100%"} height={16} index={row} />
              ))}
            </HStack>
          ))}
        </Stack>
      </Stack>
    </Stack>
  );
}
