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
 * What an operator without the admin role sees at /access.
 *
 * Shown, not hidden, and not a 404: this person is signed in and simply lacks a
 * permission they can ask for, so the screen explains who to ask instead of
 * pretending the page does not exist (core-auth-session §Ẩn / vô hiệu hoá, and
 * core-feedback-states empty kind "forbidden").
 *
 * No retry, no action button: nothing here is fixable by clicking.
 */
export function AccessForbidden({ email }: { email: string }) {
  return (
    <Layout
      height="fill"
      header={
        <LayoutHeader hasDivider>
          <Stack direction="vertical" gap={1} padding={4} maxWidth={640}>
            <Heading level={1}>Quyền truy cập</Heading>
            <Text type="supporting">Chỉ quản trị viên của đơn vị mới mở được mục này.</Text>
          </Stack>
        </LayoutHeader>
      }
      content={
        <LayoutContent padding={6}>
          <EmptyState
            headingLevel={2}
            title="Bạn không có quyền xem mục này"
            description={`Tài khoản ${email} đang đăng nhập bình thường, nhưng việc duyệt hay chặn người dùng chỉ dành cho vai trò Chủ sở hữu và Quản trị. Nhờ quản trị viên cấp quyền nếu bạn cần dùng màn này.`}
          />
        </LayoutContent>
      }
    />
  );
}
