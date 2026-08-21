"use client";

import { Grid, HStack, Skeleton, Stack, StackItem } from "@astryxdesign/core";

/**
 * Loading placeholders for the sync screen. Sizes mirror the real blocks — the
 * three funnel stage rows and the grouped issue rows in the main column, the run
 * facts in the rail — so nothing jumps when the data lands (web-feedback-states
 * rule 1: CLS = 0).
 *
 * `aria-hidden`: a screen reader gains nothing from grey boxes — the live region
 * in the screen announces "đang tải".
 */

export function SyncStatusSkeleton() {
  return (
    <Stack direction="vertical" gap={5} aria-hidden="true">
      {/* Funnel: heading + three stage rows. */}
      <Stack direction="vertical" gap={3}>
        <Skeleton width={224} height={20} />
        <Stack direction="vertical" gap={0}>
          {[0, 1, 2].map((stage) => (
            <HStack key={stage} gap={4} paddingBlock={4} align="start">
              {/* Same 144px stage-heading column as SyncFunnel. */}
              <Stack direction="vertical" gap={1} width={144}>
                <Skeleton width={24} height={12} index={stage} />
                <Skeleton width={112} height={16} index={stage} />
                <Skeleton width={80} height={12} index={stage} />
              </Stack>
              <StackItem size="fill">
                <Stack direction="vertical" gap={2}>
                  <Skeleton width={192} height={32} index={stage} />
                  <Skeleton width="100%" height={8} radius="rounded" index={stage} />
                  <Skeleton width="66%" height={16} index={stage} />
                </Stack>
              </StackItem>
            </HStack>
          ))}
        </Stack>
      </Stack>

      {/* Issues: heading + header row + four grouped rows. */}
      <Stack direction="vertical" gap={3}>
        <Skeleton width={160} height={20} />
        <Stack direction="vertical" gap={0}>
          {[0, 1, 2, 3].map((row) => (
            <HStack key={row} gap={3} paddingInline={3} paddingBlock={3} align="center">
              <Skeleton width={176} height={16} index={row} />
              <StackItem size="fill">
                <Skeleton width="100%" height={16} index={row} />
              </StackItem>
              <Skeleton width={128} height={8} radius="rounded" index={row} />
              <Skeleton width={72} height={16} index={row} />
            </HStack>
          ))}
        </Stack>
      </Stack>
    </Stack>
  );
}

/** Same block heights as `SyncRunRail`, so the rail does not resize on load. */
export function SyncRailSkeleton() {
  return (
    <Stack direction="vertical" gap={4} aria-hidden="true">
      <Stack direction="vertical" gap={2}>
        <Skeleton width={168} height={20} />
        <Skeleton width={128} height={16} />
        <Skeleton width="100%" height={16} />
      </Stack>

      <Grid columns={1} gap={2}>
        {[0, 1, 2, 3].map((row) => (
          <HStack key={row} gap={3} align="center">
            <Skeleton width={112} height={12} index={row} />
            <StackItem size="fill">
              <Skeleton width="100%" height={12} index={row} />
            </StackItem>
          </HStack>
        ))}
      </Grid>
    </Stack>
  );
}
