"use client";

import { HStack, Layout, LayoutContent, LayoutHeader, Skeleton, Stack } from "@astryxdesign/core";

import { AccessRequestTableSkeleton } from "@/ui/components/access/AccessRequestTableSkeleton";
import type { MembersTab } from "@/ui/components/members/members-tabs";
import { MemberTableSkeleton } from "@/ui/components/members/MemberTableSkeleton";

/**
 * Suspense fallback for the "Thành viên" hub. Mirrors the real frame — header
 * block, tab strip, then the body of the tab that is actually opening — so the
 * layout does not jump when `useSearchParams()` resolves (CLS = 0,
 * web-feedback-states rule 1). `aria-hidden`: grey boxes are not content.
 */
export function MembersFallback({ tab }: { tab: MembersTab }) {
  return (
    <Layout
      height="fill"
      aria-hidden="true"
      header={
        <LayoutHeader hasDivider>
          <Stack direction="vertical" gap={3} padding={4}>
            <Stack direction="vertical" gap={2}>
              <Skeleton width={140} height={28} />
              <Skeleton width="100%" height={16} />
            </Stack>
            <HStack gap={2}>
              <Skeleton width={120} height={32} />
              <Skeleton width={110} height={32} />
              <Skeleton width={140} height={32} />
            </HStack>
          </Stack>
        </LayoutHeader>
      }
      content={
        <LayoutContent padding={0}>
          <MembersTabFallback tab={tab} />
        </LayoutContent>
      }
    />
  );
}

function MembersTabFallback({ tab }: { tab: MembersTab }) {
  if (tab === "invites") {
    return (
      <Stack direction="vertical" gap={3} padding={4}>
        <Skeleton width={160} height={24} />
        <Skeleton width="100%" height={16} />
        <HStack gap={3}>
          <Skeleton width={300} height={32} />
          <Skeleton width={140} height={32} />
        </HStack>
        <Skeleton width="100%" height={16} />
        <Skeleton width="100%" height={16} />
      </Stack>
    );
  }

  if (tab === "history") {
    return (
      <Stack direction="vertical">
        <Stack direction="vertical" gap={2} paddingInline={4} paddingBlock={3}>
          <Skeleton width={180} height={24} />
          <Skeleton width="100%" height={16} />
          <HStack gap={3}>
            <Skeleton width={320} height={32} />
            <Skeleton width={96} height={32} />
          </HStack>
        </Stack>
        <AccessRequestTableSkeleton />
      </Stack>
    );
  }

  return (
    <Stack direction="vertical">
      <HStack gap={3} paddingInline={4} paddingBlock={3} align="center">
        <Skeleton width={200} height={24} />
        <Skeleton width={90} height={16} />
        <Skeleton width={96} height={32} />
      </HStack>
      <MemberTableSkeleton />
    </Stack>
  );
}
