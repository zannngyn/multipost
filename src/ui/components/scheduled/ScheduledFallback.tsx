"use client";

import { HStack, Layout, LayoutContent, LayoutHeader, Skeleton, Stack } from "@astryxdesign/core";

import { ScheduledSkeleton } from "@/ui/components/scheduled/ScheduledSkeleton";

/**
 * Suspense fallback for "Bài đã hẹn". Mirrors the real frame — header block,
 * mode switch + filter bar, then the day groups — so the layout does not jump
 * when `useSearchParams()` resolves (CLS = 0).
 *
 * It always draws the LIST shape: the mode lives in the query string, which is
 * exactly what is not known yet, and guessing the calendar would swap a 6×7 grid
 * for a timeline the moment the params land.
 */
export function ScheduledFallback() {
  return (
    <Layout
      height="fill"
      aria-hidden="true"
      header={
        <LayoutHeader hasDivider>
          <Stack direction="vertical" gap={3} padding={4}>
            <Stack direction="vertical" gap={2} maxWidth={760}>
              <Skeleton width={176} height={28} />
              <Skeleton width="100%" height={16} />
              <Skeleton width="80%" height={16} />
            </Stack>
            <HStack gap={3} align="end">
              <Skeleton width={200} height={32} />
              <Skeleton width={220} height={32} />
              <Skeleton width={170} height={32} />
              <Skeleton width={170} height={32} />
            </HStack>
          </Stack>
        </LayoutHeader>
      }
      content={
        <LayoutContent padding={0}>
          <Stack direction="vertical" paddingBlock={4}>
            <ScheduledSkeleton />
          </Stack>
        </LayoutContent>
      }
    />
  );
}
