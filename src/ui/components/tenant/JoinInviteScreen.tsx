"use client";

import { Banner, Button, Divider, Heading, Skeleton, Stack, Text } from "@astryxdesign/core";
import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";

import { ApiErrorNotice } from "@/ui/components/feedback/ApiErrorNotice";
import { useJoinTenant } from "@/ui/hooks/useTenantOnboarding";
import { MEMBERSHIP_ROLE_LABELS } from "@/ui/schemas/me.schema";
import { joinSuccessMessage } from "@/ui/schemas/tenant-onboarding.schema";

/**
 * `/join/<token>` — someone clicked an invite link (M2.2 client half).
 *
 * The token is redeemed once, on mount: the operator already expressed intent
 * by opening the link, and asking them to press a second button would only add
 * a step where nothing can be decided.
 *
 * Three states (core-feedback-states):
 *   pending — "đang kiểm tra lời mời"
 *   data    — "Bạn đã vào <công ty> với vai trò X" (+ the `alreadyMember`
 *             variant, which is a different sentence, not the same one)
 *   error   — INVITE_INVALID reads as neutral guidance, not a red failure the
 *             person caused; anything else goes through `presentApiError`
 *
 * There is no empty state: a route that exists only because someone opened a
 * token always has one of the three answers above.
 *
 * All three share one shape — h1, then a full-width status block, then the way
 * out — so the panel keeps its size and the operator's eye keeps its place
 * whichever answer comes back. The page frame (`app/join/[token]/page.tsx`)
 * supplies the Card around it, so nothing here adds a second container.
 *
 * The cache is dropped and `/api/me` re-read by `useJoinTenant`, so "Vào làm
 * việc" is a plain navigation into an app that is already on the new company.
 */
export function JoinInviteScreen({ token }: { token: string }) {
  const router = useRouter();
  const join = useJoinTenant();

  /**
   * StrictMode mounts effects twice in development. Redeeming an invite is a
   * write, so the second run must not happen — the guard is a ref rather than a
   * dependency list, because the token never changes for a mounted screen.
   */
  const hasStarted = useRef(false);
  const { mutate } = join;

  useEffect(() => {
    if (hasStarted.current) return;
    hasStarted.current = true;
    mutate({ invite: token });
  }, [mutate, token]);

  // --- Pending --------------------------------------------------------------
  // Laid out as the exact skeleton of the success state below — heading block,
  // then a banner-sized bar, then a button-sized bar. The old version drew two
  // thin text lines, so the panel doubled in height the moment the answer
  // arrived (web-feedback-states §1: a placeholder of the wrong size just moves
  // the jump rather than removing it).
  if (join.isPending || join.isIdle) {
    return (
      <Stack direction="vertical" gap={5}>
        <Stack direction="vertical" gap={1}>
          <Heading level={1}>Đang kiểm tra lời mời</Heading>
          <Text type="supporting" role="status" aria-live="polite">
            Đang kiểm tra lời mời, vui lòng đợi.
          </Text>
        </Stack>

        <Stack direction="vertical" gap={3} aria-hidden="true">
          <Skeleton width="100%" height={88} />
          <Divider />
          <Skeleton width={168} height={40} index={1} />
        </Stack>
      </Stack>
    );
  }

  // --- Success --------------------------------------------------------------
  if (join.isSuccess) {
    const roleLabel = MEMBERSHIP_ROLE_LABELS[join.data.role];
    return (
      // Header / body / footer, the shape Astryx gives a panel that ends in an
      // action. The Divider is what turns the button into a footer instead of
      // a third stacked block competing with the banner above it.
      <Stack direction="vertical" gap={5}>
        <Heading level={1}>
          {join.data.alreadyMember ? "Bạn đã là thành viên" : "Vào công ty thành công"}
        </Heading>

        <Banner
          status="success"
          role="status"
          title={joinSuccessMessage(join.data, roleLabel)}
          description={
            join.data.alreadyMember
              ? "Lời mời này trỏ tới công ty bạn vốn đã ở trong, nên không có gì thay đổi. Bạn đang làm việc ở công ty đó."
              : "Bạn đang làm việc ở công ty này. Dữ liệu của mỗi công ty tách riêng: sản phẩm, kênh và nhật ký đăng bài không dùng chung."
          }
        />

        <Divider />

        {/* `wrap` because the company name rides in the accessible label, not
            the visible one, but the row still has to survive a narrow phone. */}
        <Stack direction="horizontal" gap={2} wrap="wrap">
          <Button
            variant="primary"
            label={`Vào làm việc ở ${join.data.tenant.name}`}
            onClick={() => router.replace("/")}
          >
            Vào làm việc
          </Button>
        </Stack>
      </Stack>
    );
  }

  // --- Error ----------------------------------------------------------------
  // INVITE_INVALID is deliberately one code for every cause (hết hạn, thu hồi,
  // đã dùng, không tồn tại), so the copy in `presentApiError` does not
  // speculate. No retry either: the same token would fail the same way.
  // Same header/body rhythm as the other two, so the panel does not reshape
  // itself depending on how the invite turned out. No Divider here: the way
  // out already sits inside the notice, as its secondary action.
  return (
    <Stack direction="vertical" gap={5}>
      <Heading level={1}>Không dùng được link mời này</Heading>
      <ApiErrorNotice
        error={join.error}
        extraAction={
          <Button variant="secondary" label="Về trang chủ" onClick={() => router.replace("/")}>
            Về trang chủ
          </Button>
        }
      />
    </Stack>
  );
}
