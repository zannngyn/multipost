"use client";

import { HStack, Layout, LayoutContent, LayoutHeader, Skeleton, Stack } from "@astryxdesign/core";

import { ChannelTableSkeleton } from "@/ui/components/channels/ChannelTableSkeleton";
import type { ChannelsTab } from "@/ui/components/channels/channels-tabs";

/**
 * Suspense fallback for the "Kênh" hub. Mirrors the real frame — header block,
 * tab strip, then the body of the tab that is actually opening — so the layout
 * does not jump when `useSearchParams()` resolves (CLS = 0,
 * web-feedback-states rule 1). `aria-hidden`: grey boxes are not content.
 */
export function ChannelsFallback({ tab }: { tab: ChannelsTab }) {
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
            <HStack gap={2}>
              <Skeleton width={140} height={32} />
              <Skeleton width={110} height={32} />
              <Skeleton width={130} height={32} />
            </HStack>
          </Stack>
        </LayoutHeader>
      }
      content={
        <LayoutContent padding={0}>
          <ChannelsTabFallback tab={tab} />
        </LayoutContent>
      }
    />
  );
}

function ChannelsTabFallback({ tab }: { tab: ChannelsTab }) {
  if (tab === "connect") {
    return (
      <Stack direction="vertical" gap={3} padding={4} maxWidth={880}>
        <Skeleton width={200} height={24} />
        <Skeleton width="100%" height={56} />
        <HStack gap={2}>
          <Skeleton width={180} height={32} />
          <Skeleton width={200} height={32} />
        </HStack>
      </Stack>
    );
  }

  if (tab === "groups") {
    return (
      <Stack direction="vertical" gap={4} padding={4} maxWidth={1024}>
        <Skeleton width={160} height={28} />
        <Skeleton width="100%" height={160} />
        <Skeleton width={120} height={20} />
        <Skeleton width="100%" height={96} />
        <Skeleton width="100%" height={96} />
      </Stack>
    );
  }

  return (
    <Stack direction="vertical">
      <HStack gap={3} paddingInline={4} paddingBlock={3} align="center">
        <Skeleton width={160} height={24} />
        <Skeleton width={60} height={16} />
        <Skeleton width={96} height={32} />
      </HStack>
      <ChannelTableSkeleton />
    </Stack>
  );
}
