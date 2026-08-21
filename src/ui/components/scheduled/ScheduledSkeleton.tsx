"use client";

import { Grid, HStack, Skeleton, Stack, StackItem, VStack } from "@astryxdesign/core";

import { CALENDAR_COLUMNS, CALENDAR_ROWS } from "@/ui/components/scheduled/calendar-grid";

/** Column widths mirror ScheduledJobTable so the real rows land where these sat. */
const COLUMNS = [200, 170, 150, null, 210] as const;

/**
 * Skeleton with the SAME day heading + five columns and row height as the real
 * list (web-data-table rule 1: a mismatched skeleton is a layout shift).
 *
 * `aria-hidden`: a screen reader has nothing to gain from a wall of grey boxes.
 */
export function ScheduledSkeleton() {
  return (
    <Stack direction="vertical" gap={6} aria-hidden="true">
      {[0, 1].map((group) => (
        <Stack key={group} direction="vertical" gap={2}>
          <Stack direction="vertical" paddingInline={4}>
            <Skeleton width={224} height={20} index={group} />
          </Stack>

          {[0, 1, 2].map((row) => (
            <HStack key={row} gap={3} paddingInline={4} paddingBlock={3} align="start">
              {COLUMNS.map((width, column) =>
                width === null ? (
                  <StackItem key={column} size="fill">
                    <VStack gap={1.5}>
                      <Skeleton width="100%" height={14} index={row} />
                      <Skeleton width="80%" height={14} index={row} />
                      <Skeleton width="40%" height={14} index={row} />
                    </VStack>
                  </StackItem>
                ) : (
                  <VStack key={column} gap={1.5}>
                    <Skeleton width={width} height={14} index={row} />
                    <Skeleton width={Math.round(width * 0.6)} height={14} index={row} />
                  </VStack>
                ),
              )}
            </HStack>
          ))}
        </Stack>
      ))}
    </Stack>
  );
}

/**
 * The calendar's own skeleton: the same six rows of seven cells at the same
 * height as the real grid, so switching from skeleton to data does not move a
 * single pixel (web-feedback-states rule 1 — a mismatched skeleton IS the CLS).
 */
export function ScheduledCalendarSkeleton() {
  return (
    <Stack direction="vertical" gap={3} padding={4} aria-hidden="true">
      <HStack gap={2} align="center" wrap="wrap">
        <Skeleton width={112} height={32} />
        <Skeleton width={160} height={24} />
        <Skeleton width={96} height={32} />
      </HStack>
      <Skeleton width={288} height={16} />

      <Grid columns={CALENDAR_COLUMNS} gap={1}>
        {Array.from({ length: CALENDAR_COLUMNS }, (_unused, column) => (
          <Skeleton key={`head-${column}`} width={24} height={16} />
        ))}
        {Array.from({ length: CALENDAR_ROWS * CALENDAR_COLUMNS }, (_unused, cell) => (
          <Skeleton
            key={cell}
            width="100%"
            height={112}
            radius={4}
            index={Math.floor(cell / CALENDAR_COLUMNS)}
          />
        ))}
      </Grid>
    </Stack>
  );
}
