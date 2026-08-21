"use client";

import { EmptyState, Heading, Stack, Text } from "@astryxdesign/core";

/**
 * What an operator without the admin role sees on the "Lịch sử duyệt" tab.
 *
 * Shown, not hidden, and not a 404: this person is signed in and simply lacks a
 * permission they can ask for, so the tab explains who to ask instead of
 * pretending it does not exist (core-auth-session §Ẩn / vô hiệu hoá, and
 * core-feedback-states empty kind "forbidden").
 *
 * A PANEL since the wave-1 IA — the "Thành viên" hub owns the frame and the h1,
 * so this starts at h2 exactly like the panel it stands in for. The guard that
 * decides whether to render it stays on the server (`/members/page.tsx`), and
 * `GET /api/access-requests` refuses the same people regardless: hiding rows in
 * the client is UX, not security.
 *
 * No retry, no action button: nothing here is fixable by clicking.
 */
export function AccessForbidden({ email }: { email: string }) {
  return (
    <Stack direction="vertical" gap={3} padding={4}>
      <Stack direction="vertical" gap={1}>
        <Heading level={2}>Lịch sử duyệt</Heading>
        <Text type="supporting">Chỉ quản trị viên của đơn vị mới mở được mục này.</Text>
      </Stack>

      <EmptyState
        headingLevel={3}
        title="Bạn không có quyền xem mục này"
        description={`Tài khoản ${email} đang đăng nhập bình thường, nhưng lịch sử duyệt người dùng chỉ dành cho vai trò Chủ sở hữu và Quản trị. Nhờ quản trị viên cấp quyền nếu bạn cần tra cứu mục này.`}
      />
    </Stack>
  );
}
