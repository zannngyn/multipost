"use client";

import { Banner, Button, Heading, Skeleton, Stack, Text } from "@astryxdesign/core";
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
  if (join.isPending || join.isIdle) {
    return (
      <Stack direction="vertical" gap={3}>
        <Heading level={1}>Đang kiểm tra lời mời</Heading>
        <Text type="supporting" role="status" aria-live="polite">
          Đang kiểm tra lời mời, vui lòng đợi.
        </Text>
        <Stack direction="vertical" gap={2} aria-hidden="true">
          <Skeleton width="100%" height={16} />
          <Skeleton width="70%" height={16} />
        </Stack>
      </Stack>
    );
  }

  // --- Success --------------------------------------------------------------
  if (join.isSuccess) {
    const roleLabel = MEMBERSHIP_ROLE_LABELS[join.data.role];
    return (
      <Stack direction="vertical" gap={3}>
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
        <Stack direction="horizontal" gap={2}>
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
  return (
    <Stack direction="vertical" gap={3}>
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
