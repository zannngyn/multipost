"use client";

import { Card, Divider, Heading, Stack, Text } from "@astryxdesign/core";

import { CreateTenantForm } from "@/ui/components/tenant/CreateTenantForm";
import { JoinInviteForm } from "@/ui/components/tenant/JoinInviteForm";
import { useCreateTenant, useJoinTenant } from "@/ui/hooks/useTenantOnboarding";

/**
 * What a signed-in account with no company sees (M2.1) — the NoMembership state
 * of `TenantBoundary`.
 *
 * Two ways in, both offered at once: create your own, or use an invite you were
 * sent. Before M2.1 this screen could only say "chờ được mời", which left an
 * operator with a working account and no way to use it.
 *
 * Both mutations end in the SAME place (`useAdoptActiveTenant`): the server has
 * already set the active-tenant cookie, the cache is dropped and `/api/me` is
 * re-read — so the boundary above re-renders straight into the app. There is
 * deliberately no success screen in between: the proof is being inside.
 */
export function OnboardingPanel() {
  const create = useCreateTenant();
  const join = useJoinTenant();

  return (
    <Stack direction="vertical" gap={5}>
      <Stack direction="vertical" gap={1} maxWidth="70ch">
        <Heading level={1}>Bắt đầu với MYSP</Heading>
        <Text type="supporting">
          Bạn đã đăng nhập thành công, đây không phải lỗi. Dữ liệu trong MYSP luôn thuộc về một công
          ty, nên hãy tạo công ty của bạn, hoặc dùng link mời nếu ai đó đã mời bạn vào công ty của
          họ.
        </Text>
      </Stack>

      {/* The two ways in are not equals: creating is what most people here need
          to do, so it gets the surface and the invite path gets the muted one.
          Two identical cards would make the operator choose before reading. */}
      <Card padding={5}>
        <Stack direction="vertical" gap={3}>
          <Stack direction="vertical" gap={1}>
            <Heading level={2}>Tạo công ty của bạn</Heading>
            <Text type="supporting">
              Bạn sẽ là chủ sở hữu, và có thể mời người khác vào sau.
            </Text>
          </Stack>

          <CreateTenantForm
            hasAutoFocus
            onSubmit={(values) => {
              join.reset();
              create.reset();
              create.mutate(values);
            }}
            isPending={create.isPending}
            error={create.isError ? create.error : null}
          />
        </Stack>
      </Card>

      <Divider label={<Text type="supporting">hoặc</Text>} />

      <Card padding={5} variant="muted">
        <Stack direction="vertical" gap={3}>
          <Stack direction="vertical" gap={1}>
            <Heading level={2}>Có link mời? Dán vào đây</Heading>
            <Text type="supporting">
              Dùng khi quản trị viên của một công ty đã gửi link mời cho bạn.
            </Text>
          </Stack>

          <JoinInviteForm
            onSubmit={({ invite }) => {
              create.reset();
              join.reset();
              join.mutate({ invite });
            }}
            isPending={join.isPending}
            error={join.isError ? join.error : null}
          />
        </Stack>
      </Card>
    </Stack>
  );
}
