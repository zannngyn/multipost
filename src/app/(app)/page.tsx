// Subpath imports, not the package root: `@astryxdesign/core`'s barrel carries
// a "use client" directive, so importing it from a Server Component would turn
// this page into a client boundary and ship the whole library with it
// (web-component-reuse §2b).
import { Banner } from "@astryxdesign/core/Banner";
import { Heading } from "@astryxdesign/core/Heading";
import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { redirect } from "next/navigation";

import { getOperatorSession } from "@/app/_auth/session";
import { TenantHealthPanel } from "@/ui/components/tenant/TenantHealthPanel";

/**
 * Protected home. Server Component: the session is resolved before anything
 * renders, so there is no "unknown" flash and no private markup can leak
 * (core-auth-session: three session states).
 *
 * The operator identity and the sign-out action live in the shell's top bar and
 * side nav, so this page is content only. The brand is in the top bar too —
 * repeating it in the <h1> would spend the page's one strongest line saying
 * something the operator can already read two centimetres higher. The heading
 * names the SCREEN instead.
 *
 * The overview proper (KPI tiles + "việc cần làm") lands in B4; today the one
 * honest widget is the health check, and it is laid out as one widget rather
 * than padded out with placeholders for numbers nobody has measured yet.
 */

/** Session-dependent: never prerendered, never cached by a proxy. */
export const dynamic = "force-dynamic";

export default async function HomePage() {
  const session = await getOperatorSession("page:/");

  // Defence in depth: middleware and the (app) layout already block this route,
  // but a Server Component must not trust that it was reached through a guard.
  if (!session) redirect("/signin?returnUrl=%2F");

  return (
    <Stack direction="vertical" gap={6} padding={6} maxWidth={1120}>
      <Stack direction="vertical" gap={1} maxWidth="70ch">
        <Heading level={1}>Tổng quan</Heading>
        <Text type="supporting">
          Điểm bắt đầu của một ca trực: xác nhận hệ thống còn thông suốt trước khi soạn bài hay chạy
          hàng loạt.
        </Text>
      </Stack>

      {/* A standing fact about the session, not an error: the operator is not
          signed in as themselves, and every row below belongs to a fake
          account. `role="status"` — nothing is wrong, nothing is interrupting. */}
      {session.isDevFake ? (
        <Banner
          role="status"
          status="warning"
          title="Phiên giả lập DEV: chưa đăng nhập thật"
          description="Dữ liệu và quyền trên màn hình này là của tài khoản giả lập. Tắt biến DEV_FAKE_SESSION để dùng đăng nhập Google."
        />
      ) : null}

      <TenantHealthPanel />
    </Stack>
  );
}
