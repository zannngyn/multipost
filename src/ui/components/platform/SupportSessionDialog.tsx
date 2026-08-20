"use client";

import { Banner, Button, Dialog, DialogHeader, HStack, Stack, Text, TextArea } from "@astryxdesign/core";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { ApiErrorNotice } from "@/ui/components/feedback/ApiErrorNotice";
import { useStartSupportSession } from "@/ui/hooks/usePlatformTenants";
import {
  SUPPORT_PURPOSE_MIN,
  StartSupportSessionFormSchema,
  type PlatformTenant,
} from "@/ui/schemas/platform.schema";

/**
 * "Vào hỗ trợ" (M3.3) — MYSP staff stepping into a customer's company.
 *
 * The purpose box is not a formality and the copy says so: the line is written
 * into the CUSTOMER's audit trail, and they read it. Making that visible before
 * the click is the difference between a support tool and surveillance.
 *
 * `purpose="form"` so a stray backdrop click cannot throw away a typed reason,
 * and the dialog refuses to close mid-request — the answer decides which
 * company the whole app is looking at.
 *
 * On success `useStartSupportSession` drops the cache and re-reads `/api/me`
 * (the server has already moved the cookie), then this navigates to the tenant
 * home so the operator lands where they actually asked to be.
 */
export function SupportSessionDialog({
  tenant,
  isOpen,
  onOpenChange,
}: {
  /** Null while no row is chosen — the dialog stays closed. */
  tenant: PlatformTenant | null;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const start = useStartSupportSession();
  const [purpose, setPurpose] = useState("");
  const [purposeError, setPurposeError] = useState<string | null>(null);

  function close() {
    start.reset();
    setPurpose("");
    setPurposeError(null);
    onOpenChange(false);
  }

  function submit() {
    if (!tenant) return;

    // Validated at the boundary, before anything leaves the browser: the server
    // enforces the same minimum and would answer with the same sentence.
    const parsed = StartSupportSessionFormSchema.safeParse({ purpose });
    if (!parsed.success) {
      setPurposeError(parsed.error.issues[0]?.message ?? "Mục đích chưa hợp lệ.");
      return;
    }

    setPurposeError(null);
    start.mutate(
      { tenantId: tenant.id, purpose: parsed.data.purpose },
      {
        onSuccess: () => {
          onOpenChange(false);
          setPurpose("");
          // The app is already pointing at the customer's company; land on its
          // home rather than leaving the operator on the platform list.
          router.push("/");
        },
      },
    );
  }

  return (
    <Dialog
      isOpen={isOpen && tenant !== null}
      onOpenChange={(open) => {
        if (!open && start.isPending) return;
        if (!open) close();
      }}
      purpose="form"
      width={560}
    >
      <DialogHeader
        title={tenant ? `Vào hỗ trợ ${tenant.name}` : "Vào hỗ trợ"}
        subtitle="Phiên chỉ đọc, có thời hạn, và được ghi lại."
        onOpenChange={start.isPending ? undefined : () => close()}
      />
      <Stack direction="vertical" gap={3} padding={4}>
        <Banner
          status="warning"
          title="Mỗi lần vào đều được ghi vào sổ của khách"
          description="Khách xem được ai đã vào, lúc nào và với mục đích gì. Trong phiên hỗ trợ bạn chỉ đọc được dữ liệu — mọi thao tác ghi đều bị từ chối."
        />

        <TextArea
          label="Mục đích vào hỗ trợ"
          description={`Bắt buộc, ít nhất ${SUPPORT_PURPOSE_MIN} ký tự. Viết cho khách đọc, ví dụ: "Kiểm tra vì sao bài ngày 20/08 không lên".`}
          isRequired
          rows={3}
          value={purpose}
          onChange={(value) => {
            setPurpose(value);
            if (purposeError) setPurposeError(null);
          }}
          isDisabled={start.isPending}
          status={purposeError ? { type: "error", message: purposeError } : undefined}
          statusVariant="detached"
        />

        {start.isError ? <ApiErrorNotice error={start.error} operation="platform" /> : null}

        <HStack gap={2} align="center" wrap="wrap">
          {/* Never disabled on empty: bấm được, rồi chỉ ra thiếu gì. */}
          <Button
            variant="primary"
            label={tenant ? `Vào hỗ trợ ${tenant.name}` : "Vào hỗ trợ"}
            isLoading={start.isPending}
            isDisabled={start.isPending}
            onClick={submit}
          >
            Vào hỗ trợ
          </Button>
          <Button
            variant="ghost"
            label="Huỷ"
            isDisabled={start.isPending}
            onClick={close}
          />
        </HStack>

        <Text type="supporting" role="status" aria-live="polite">
          {start.isPending ? "Đang mở phiên hỗ trợ, vui lòng đợi" : ""}
        </Text>
      </Stack>
    </Dialog>
  );
}
