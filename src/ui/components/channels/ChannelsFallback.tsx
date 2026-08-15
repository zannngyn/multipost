"use client";

import { Divider, HStack, Layout, LayoutContent, LayoutHeader, Skeleton, Stack } from "@astryxdesign/core";

import { ChannelTableSkeleton } from "@/ui/components/channels/ChannelTableSkeleton";

/**
 * Suspense fallback for the "Kênh" screen. Mirrors the real frame — header
 * block, connect block, then the rows — so the layout does not jump when
 * `useSearchParams()` resolves (CLS = 0).
 */
export function ChannelsFallback() {
  return (
    <Layout
      height="fill"
      aria-hidden="true"
      header={
        <LayoutHeader hasDivider>
          <Stack direction="vertical" gap={3} padding={4}>
            <Stack direction="vertical" gap={2}>
              <Skeleton width={120} height={28} />
              <Skeleton width="100%" height={16} />
            </Stack>
            <Skeleton width={96} height={32} />
          </Stack>
        </LayoutHeader>
      }
      content={
        <LayoutContent padding={0}>
          <Stack direction="vertical">
            <Stack direction="vertical" gap={3} padding={4}>
              <Skeleton width={200} height={24} />
              <Skeleton width="100%" height={56} />
              <HStack gap={2}>
                <Skeleton width={180} height={32} />
                <Skeleton width={200} height={32} />
              </HStack>
            </Stack>
            <Divider />
            <ChannelTableSkeleton />
          </Stack>
        </LayoutContent>
      }
    />
  );
}
