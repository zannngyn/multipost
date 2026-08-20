"use client";

import {
  EmptyState,
  Heading,
  Layout,
  LayoutContent,
  LayoutHeader,
  Stack,
  Text,
} from "@astryxdesign/core";

/**
 * What someone without a platform role sees at `/platform`.
 *
 * Shown, not hidden, and not a 404 — but deliberately vague: this person is
 * signed in and simply typed a URL they were never offered (the nav hides the
 * section). Naming what lives here would tell a customer's operator that MYSP
 * has an internal admin screen, which is the leak the hidden nav avoids in the
 * first place (core-auth-session §cây quyết định).
 *
 * No retry, no action: nothing here is fixable by clicking.
 */
export function PlatformForbidden({ email }: { email: string }) {
  return (
    <Layout
      height="fill"
      header={
        <LayoutHeader hasDivider>
          <Stack direction="vertical" gap={1} padding={4}>
            <Heading level={1}>Không mở được mục này</Heading>
            <Text type="supporting">Mục này dành cho quản trị hệ thống MYSP.</Text>
          </Stack>
        </LayoutHeader>
      }
      content={
        <LayoutContent padding={4}>
          <EmptyState
            headingLevel={2}
            title="Bạn không có quyền xem mục này"
            description={`Tài khoản ${email} đang đăng nhập bình thường và dùng được mọi màn hình của công ty bạn — riêng mục này thuộc về đội vận hành MYSP. Nếu bạn cho rằng đây là nhầm lẫn, liên hệ MYSP.`}
          />
        </LayoutContent>
      }
    />
  );
}
