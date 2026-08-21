"use client";

import { Layout, LayoutContent, LayoutHeader, HStack, Skeleton, Stack } from "@astryxdesign/core";

import { AccessRequestTableSkeleton } from "@/ui/components/access/AccessRequestTableSkeleton";

/**
 * Suspense fallback for "Quyền truy cập". Mirrors the real frame — title block
 * with its action on the right, the toolbar row, then the rows — so the layout
 * does not jump when `useSearchParams()` resolves (CLS = 0).
 */
export function AccessFallback() {
  return (
    <Layout
      height="fill"
      aria-hidden="true"
      header={
        <LayoutHeader hasDivider>
          <HStack gap={4} padding={4} justify="between" align="start">
            <Stack direction="vertical" gap={2} maxWidth={640} width="100%">
              <Skeleton width={180} height={28} />
              <Skeleton width="100%" height={16} />
            </Stack>
            <Skeleton width={96} height={32} />
          </HStack>
        </LayoutHeader>
      }
      content={
        <LayoutContent padding={0}>
          <Stack direction="vertical">
            {/* The retired-queue banner holds this much room on the real
                screen; leaving it out would push the rows up and then down. */}
            <Stack direction="vertical" paddingInline={4} paddingBlock={3}>
              <Skeleton width="100%" height={72} />
            </Stack>
            <HStack gap={3} paddingInline={4} paddingBlock={3} justify="between" align="center">
              <Skeleton width={200} height={24} />
              <Skeleton width={320} height={32} />
            </HStack>
            <AccessRequestTableSkeleton />
          </Stack>
        </LayoutContent>
      }
    />
  );
}
