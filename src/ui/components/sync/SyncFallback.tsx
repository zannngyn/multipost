"use client";

import {
  HStack,
  Layout,
  LayoutContent,
  LayoutHeader,
  LayoutPanel,
  Skeleton,
  Stack,
} from "@astryxdesign/core";

import { SyncRailSkeleton, SyncStatusSkeleton } from "@/ui/components/sync/SyncStatusSkeleton";

/**
 * Suspense fallback for "Đồng bộ dữ liệu". The screen reads the Google OAuth
 * callback from the query string, so it suspends until the request's search
 * params are known; this mirrors the real frame — header, content column, end
 * panel — so the layout does not jump when they resolve (CLS = 0).
 */
export function SyncFallback() {
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
            </Stack>
            <HStack gap={3} align="center">
              <Skeleton width={144} height={36} />
            </HStack>
          </Stack>
        </LayoutHeader>
      }
      content={
        <LayoutContent padding={0} isScrollable>
          <Stack direction="vertical" gap={5} paddingInline={4} paddingBlock={4}>
            {/* Same height as the "Nguồn đang đọc" region. */}
            <Skeleton width="100%" height={200} />
            <SyncStatusSkeleton />
          </Stack>
        </LayoutContent>
      }
      end={
        <LayoutPanel width={360} hasDivider isScrollable label="Chi tiết lần chạy">
          <Stack direction="vertical" padding={4}>
            <SyncRailSkeleton />
          </Stack>
        </LayoutPanel>
      }
    />
  );
}
