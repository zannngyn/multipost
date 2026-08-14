"use client";

import { HStack, Layout, LayoutContent, LayoutHeader, Skeleton, Stack } from "@astryxdesign/core";

import { ProductTableSkeleton } from "@/ui/components/products/ProductTableSkeleton";

/**
 * Suspense fallback for the product screen. Mirrors the real frame — header
 * block, filter row, then the rows — so the layout does not jump when
 * `useSearchParams()` resolves (CLS = 0).
 */
export function ProductsFallback() {
  return (
    <Layout
      height="fill"
      aria-hidden="true"
      header={
        <LayoutHeader hasDivider>
          <Stack direction="vertical" gap={3} padding={4}>
            <Stack direction="vertical" gap={2}>
              <Skeleton width={160} height={28} />
              <Skeleton width="100%" height={16} />
            </Stack>
            <HStack gap={3} align="center">
              <Skeleton width="100%" height={32} />
              <Skeleton width={320} height={32} />
            </HStack>
          </Stack>
        </LayoutHeader>
      }
      content={
        <LayoutContent padding={0}>
          <ProductTableSkeleton />
        </LayoutContent>
      }
    />
  );
}
