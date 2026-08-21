"use client";

import { HStack, Layout, LayoutContent, LayoutHeader, Skeleton, Stack } from "@astryxdesign/core";

import { JobLogSkeleton } from "@/ui/components/jobs/JobLogSkeleton";

/**
 * Suspense fallback for "Nhật ký đăng bài". Mirrors the real frame — header
 * block, filter bar, then the rows — so the layout does not jump when
 * `useSearchParams()` resolves (CLS = 0).
 */
export function JobsFallback() {
  return (
    <Layout
      height="fill"
      aria-hidden="true"
      header={
        <LayoutHeader hasDivider>
          <Stack direction="vertical" gap={3} padding={4}>
            <Stack direction="vertical" gap={2}>
              <Skeleton width={224} height={28} />
              <Skeleton width="100%" height={16} />
              <Skeleton width="70%" height={16} />
            </Stack>
            <HStack gap={3} align="end">
              <Skeleton width={240} height={32} />
              <Skeleton width={96} height={32} />
            </HStack>
          </Stack>
        </LayoutHeader>
      }
      content={
        <LayoutContent padding={0}>
          <JobLogSkeleton />
        </LayoutContent>
      }
    />
  );
}
