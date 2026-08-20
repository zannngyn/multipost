"use client";

import { Heading, Skeleton, Stack, Text } from "@astryxdesign/core";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

import { ApiErrorNotice } from "@/ui/components/feedback/ApiErrorNotice";
import { OnboardingPanel } from "@/ui/components/tenant/OnboardingPanel";
import { isTenantIndependentPath } from "@/ui/components/tenant/tenant-independent-paths";
import { TenantPicker } from "@/ui/components/tenant/TenantPicker";
import { useDelayedFlag } from "@/ui/hooks/useDelayedFlag";
import { useActiveTenant, useMe } from "@/ui/hooks/useMe";

/**
 * The gate between "signed in" and "working in a company" (M1.4).
 *
 * Every tenant-scoped route answers 409 TENANT_NOT_SELECTED when no company is
 * active, so without this each of the twelve screens would render its own
 * version of that message. It is answered ONCE here, from `/api/me`, before any
 * screen below asks for data (core-auth-session: block before rendering, not
 * after — and never a screen full of dead buttons).
 *
 * Four states, in the order they can happen:
 *   loading — skeleton in the content area, delayed 300ms
 *   error   — /api/me itself failed; 4xx offers no pointless retry
 *   picker  — several companies, none selected → choose one
 *   empty   — signed in, member of nothing → "chờ được mời" (M2.1 adds "tạo")
 * Anything else renders the screen.
 */
export function TenantBoundary({ children }: { children: ReactNode }) {
  const me = useMe();
  const pathname = usePathname();
  const { hasNoMembership, mustPickTenant, tenants } = useActiveTenant();

  const isFirstLoad = me.isPending && me.fetchStatus === "fetching";
  const showSkeleton = useDelayedFlag(isFirstLoad);

  /**
   * Some screens inside the shell are not about a company at all (M3.2). A
   * platform admin with no membership must reach `/platform`, not the
   * onboarding screen — same pass-through the bootstrap session already has,
   * for the same reason: this boundary answers "which company?", and that is
   * not a question these routes ask.
   *
   * They guard themselves server-side; letting them past a boundary about
   * TENANTS grants nothing.
   */
  if (isTenantIndependentPath(pathname)) return <>{children}</>;

  // --- Loading --------------------------------------------------------------
  if (isFirstLoad) {
    return showSkeleton ? (
      <Stack direction="vertical" gap={3} padding={4} aria-hidden="true">
        <Skeleton width={240} height={28} />
        <Skeleton width="100%" height={16} />
        <Skeleton width="100%" height={200} />
      </Stack>
    ) : null;
  }

  // --- Error: the identity call itself failed -------------------------------
  // Nothing below can be trusted without it: a screen rendered here would ask
  // for data on behalf of a company nobody has established.
  if (me.isError && !me.data) {
    return (
      <Stack direction="vertical" gap={3} padding={4}>
        <Heading level={1}>Chưa mở được phiên làm việc</Heading>
        <ApiErrorNotice error={me.error} onRetry={() => void me.refetch()} />
      </Stack>
    );
  }

  // --- Empty: signed in, but a member of no company -------------------------
  // Not a dead end any more (M2.1): create one, or use an invite.
  if (hasNoMembership) {
    return (
      <Stack direction="vertical" padding={4} maxWidth={720}>
        <OnboardingPanel />
      </Stack>
    );
  }

  // --- Fork in the road: several companies, none chosen ---------------------
  if (mustPickTenant) {
    return (
      <Stack direction="vertical" gap={4} padding={4}>
        <Stack direction="vertical" gap={1}>
          <Heading level={1}>Chọn công ty để làm việc</Heading>
          <Text type="supporting">
            Tài khoản của bạn thuộc {tenants.length} công ty. Mỗi công ty có sản phẩm, kênh và nhật
            ký riêng — chọn một công ty để bắt đầu; bạn đổi lại lúc nào cũng được.
          </Text>
        </Stack>
        <TenantPicker />
      </Stack>
    );
  }

  return <>{children}</>;
}
