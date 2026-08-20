"use client";

import { Dialog, DialogHeader, Stack, Text } from "@astryxdesign/core";

import { CreateTenantForm } from "@/ui/components/tenant/CreateTenantForm";
import { useCreateTenant } from "@/ui/hooks/useTenantOnboarding";

/**
 * "Tạo công ty mới…" from the switcher (M2.1 + M2.3).
 *
 * Same form as the first-run screen — one component, two places
 * (core-component-reuse). Only the frame differs.
 *
 * `purpose="form"`: an accidental backdrop click must not throw away a half
 * typed company name (core-form-architecture §bảng phân xử chạm ra ngoài).
 * Escape still closes, which is why nothing is submitted from here without the
 * button.
 *
 * On success the cache is dropped and `/api/me` re-read by `useCreateTenant`,
 * so the whole app is already looking at the new company by the time this
 * closes — no "chuyển sang công ty vừa tạo" step for the operator to perform.
 */
export function CreateTenantDialog({
  isOpen,
  onOpenChange,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const create = useCreateTenant();

  function close() {
    create.reset();
    onOpenChange(false);
  }

  return (
    <Dialog
      isOpen={isOpen}
      onOpenChange={(open) => {
        // Never yank the dialog away mid-request: the answer decides which
        // company the operator is in, and they must be here to read it.
        if (!open && create.isPending) return;
        if (!open) close();
      }}
      purpose="form"
      width={520}
    >
      <DialogHeader
        title="Tạo công ty mới"
        subtitle="Bạn sẽ là chủ sở hữu công ty này và được chuyển sang làm việc ở đó ngay."
        // No close button while the request is in flight — the same rule as the
        // backdrop, in the one place a keyboard user would reach for it.
        onOpenChange={create.isPending ? undefined : () => close()}
      />
      <Stack direction="vertical" gap={3} padding={4}>
        <Text type="supporting">
          Dữ liệu của mỗi công ty tách riêng: sản phẩm, kênh và nhật ký đăng bài không dùng chung.
        </Text>

        <CreateTenantForm
          hasAutoFocus
          onSubmit={(values) =>
            create.mutate(values, {
              // Closing only after the switch has landed: the boundary above
              // re-renders on the new company, and this dialog goes with it.
              onSuccess: () => onOpenChange(false),
            })
          }
          isPending={create.isPending}
          error={create.isError ? create.error : null}
          onCancel={close}
        />
      </Stack>
    </Dialog>
  );
}
