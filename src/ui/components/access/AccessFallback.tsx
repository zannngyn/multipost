"use client";

import { Layout, LayoutContent, LayoutHeader, HStack, Skeleton, Stack } from "@astryxdesign/core";

import { AccessRequestTableSkeleton } from "@/ui/components/access/AccessRequestTableSkeleton";

/**
 * Suspense fallback for "Quyền truy cập". Mirrors the real frame — title block,
 * filter row, then the rows — so the layout does not jump when
 * `useSearchParams()` resolves (CLS = 0).
 */
export function AccessFallback() {
  return (
    <Layout
      height="fill"
      aria-hidden="true"
      header={
        <LayoutHeader hasDivider>
          <Stack direction="vertical" gap={3} padding={4}>
            <Stack direction="vertical" gap={2}>
              <Skeleton width={180} height={28} />
              <Skeleton width="100%" height={16} />
            </Stack>
            <HStack gap={3}>
              <Skeleton width={320} height={32} />
              <Skeleton width={96} height={32} />
            </HStack>
          </Stack>
        </LayoutHeader>
      }
      content={
        <LayoutContent padding={0}>
          <Stack direction="vertical">
            <Stack direction="vertical" gap={2} paddingInline={4} paddingBlock={3}>
              <Skeleton width={200} height={24} />
            </Stack>
            <AccessRequestTableSkeleton />
          </Stack>
        </LayoutContent>
      }
    />
  );
}
