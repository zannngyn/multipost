"use client";

import { Card, Divider, Heading, Stack, Text } from "@astryxdesign/core";

import { CreateTenantForm } from "@/ui/components/tenant/CreateTenantForm";
import { JoinInviteForm } from "@/ui/components/tenant/JoinInviteForm";
import { Eyebrow } from "@/ui/components/ui/eyebrow";
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
    <Stack direction="vertical" gap={4}>
      <Stack direction="vertical" gap={1}>
        <Eyebrow>BƯỚC 0 — KHÔNG GIAN LÀM VIỆC</Eyebrow>
        <Heading level={1} className="text-foreground text-2xl font-bold tracking-tight">
          Bắt đầu với xưởng của bạn
        </Heading>
        <Text type="supporting" className="text-xs text-muted-foreground leading-relaxed">
          Bạn đã đăng nhập thành công. Dữ liệu sản phẩm, bài đăng và kênh bán hàng luôn thuộc về một
          công ty cụ thể. Hãy tạo công ty mới của bạn, hoặc dùng link mời nếu quản trị viên đã gửi link cho bạn.
        </Text>
      </Stack>

      <Card padding={4} className="border-border bg-card shadow-xs">
        <Stack direction="vertical" gap={3}>
          <Stack direction="vertical" gap={1}>
            <Stack direction="horizontal" gap={2} align="center">
              <span className="font-mono text-xs font-semibold px-2 py-0.5 rounded border bg-primary text-primary-foreground border-primary">
                CÁCH 1
              </span>
              <Heading level={2} className="text-foreground text-base font-semibold">
                Tạo công ty của bạn
              </Heading>
            </Stack>
            <Text type="supporting" className="text-xs text-muted-foreground">
              Bạn sẽ là chủ sở hữu (owner) với toàn quyền quản trị và mời thành viên vào sau.
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

      <Divider orientation="horizontal" />

      <Card padding={4} className="border-border bg-card shadow-xs">
        <Stack direction="vertical" gap={3}>
          <Stack direction="vertical" gap={1}>
            <Stack direction="horizontal" gap={2} align="center">
              <span className="font-mono text-xs font-semibold px-2 py-0.5 rounded border bg-muted border-border text-muted-foreground">
                CÁCH 2
              </span>
              <Heading level={2} className="text-foreground text-base font-semibold">
                Có link mời? Dán vào đây
              </Heading>
            </Stack>
            <Text type="supporting" className="text-xs text-muted-foreground">
              Dành cho nhân viên biên tập (editor) hoặc người xem đã nhận được link mời từ quản trị viên.
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
