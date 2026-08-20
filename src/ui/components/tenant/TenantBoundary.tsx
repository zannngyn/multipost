"use client";

import { Banner, EmptyState, Heading, Skeleton, Stack, Text } from "@astryxdesign/core";
import type { ReactNode } from "react";

import { ApiErrorNotice } from "@/ui/components/feedback/ApiErrorNotice";
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
  const { hasNoMembership, mustPickTenant, tenants } = useActiveTenant();

  const isFirstLoad = me.isPending && me.fetchStatus === "fetching";
  const showSkeleton = useDelayedFlag(isFirstLoad);

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
  if (hasNoMembership) {
    return <NoMembership />;
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

/**
 * NoMembership (docs/09 §3.8). Temporary by design: "Tạo công ty" is M2.1, so
 * offering a button that does nothing would be worse than saying plainly that
 * the way in today is an invitation.
 */
function NoMembership() {
  return (
    <Stack direction="vertical" gap={4} padding={4}>
      <Stack direction="vertical" gap={1}>
        <Heading level={1}>Tài khoản chưa thuộc công ty nào</Heading>
        <Text type="supporting">
          Bạn đã đăng nhập thành công — đây không phải lỗi đăng nhập.
        </Text>
      </Stack>

      <EmptyState
        headingLevel={2}
        title="Chờ được mời vào một công ty"
        description="Dữ liệu trong MYSP luôn thuộc về một công ty cụ thể, nên chưa có gì để hiển thị cho tới khi bạn là thành viên của một công ty. Hãy nhờ quản trị viên của công ty mời tài khoản này vào."
      />

      <Banner
        status="info"
        title="Tự tạo công ty thì sao?"
        description="Chức năng tự tạo công ty đang được làm và sẽ có ở bản kế tiếp. Hiện tại lối vào duy nhất là lời mời từ quản trị viên."
      />
    </Stack>
  );
}
