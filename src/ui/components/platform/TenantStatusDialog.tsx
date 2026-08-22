"use client";

import {
  Banner,
  Button,
  Dialog,
  DialogHeader,
  HStack,
  Stack,
  Text,
  TextArea,
} from "@astryxdesign/core";
import { useState } from "react";

import {
  SUSPEND_REASON_MIN,
  TenantStatusReasonFormSchema,
  activateConsequence,
  isInternalTenant,
  suspendConsequence,
  type PlatformTenant,
} from "@/ui/schemas/platform.schema";

/**
 * The confirmation behind "Khoá công ty" / "Mở khoá công ty".
 *
 * It used to be an inline block inside the row's action cell, which forced the
 * action column to stay 420px wide for a form nobody sees most of the time.
 * Now that the trigger is one item in a "⋯" menu (spec §3.2 — hành động nguy
 * hiểm ra menu riêng), the menu closes on select and the confirmation needs a
 * surface of its own. A dialog is the honest one: this is the heaviest action
 * in the product — it locks a whole company out at once — and it demands a
 * typed reason, i.e. exactly the "interruption + protected focus" a modal is
 * for. The same call `SupportSessionDialog` makes one row over.
 *
 * NOTHING about the decision changed: the same two steps (ask → confirm), the
 * same MANDATORY reason validated against the same schema at the boundary, the
 * same consequence sentence read before the click, the same internal-tenant
 * warning, and the same server requirement of a reason in BOTH directions
 * (`_lib/set-status.ts`) — one book entry without the other would leave a
 * company mysteriously back online. Confirming still hands the decision
 * straight back to the table and closes, which is what the inline block did;
 * the row carries the "đang lưu" state and the screen announces the outcome.
 *
 * `purpose="form"` so a stray backdrop click cannot throw away a typed reason.
 * Mounted only while a row is being confirmed, so every open starts on an empty
 * box — a reason typed for one company can never ride over to another.
 */
export function TenantStatusDialog({
  tenant,
  onCancel,
  onConfirm,
}: {
  /** The row being confirmed. Null keeps the dialog unmounted. */
  tenant: PlatformTenant | null;
  onCancel: () => void;
  onConfirm: (tenant: PlatformTenant, reason: string) => void;
}) {
  const [reason, setReason] = useState("");
  const [reasonError, setReasonError] = useState<string | null>(null);

  if (!tenant) return null;

  const target = tenant;
  const isSuspended = target.status === "suspended";
  const verb = isSuspended ? "mở khoá" : "khoá";

  function submit() {
    // Validated at the boundary, before anything leaves the browser: the server
    // enforces the same minimum, and a round trip would say the same thing.
    const parsed = TenantStatusReasonFormSchema.safeParse({ reason });
    if (!parsed.success) {
      setReasonError(parsed.error.issues[0]?.message ?? "Lý do chưa hợp lệ.");
      return;
    }
    setReasonError(null);
    onConfirm(target, parsed.data.reason);
  }

  return (
    <Dialog isOpen onOpenChange={(open) => (open ? undefined : onCancel())} purpose="form" width={560}>
      <DialogHeader
        title={isSuspended ? `Mở khoá ${target.name}` : `Khoá ${target.name}`}
        subtitle={
          isSuspended
            ? "Thành viên của công ty này vào lại được ngay."
            : "Cả công ty mất quyền vào cho tới khi được mở lại."
        }
        onOpenChange={() => onCancel()}
      />
      <Stack direction="vertical" gap={3} padding={4}>
        {/* The consequence, spelled out before the click — the sentence the
            inline block carried, kept word for word. */}
        <Text role="alert">
          {isSuspended
            ? `Mở khoá ${target.name}? ${activateConsequence(target)}`
            : `Khoá ${target.name}? ${suspendConsequence(target)}`}
        </Text>

        {/* The one row where "khoá công ty này" means "khoá chính chúng ta" —
            worth its own band here, where there is room to say it. */}
        {!isSuspended && isInternalTenant(target) ? (
          <Banner
            status="warning"
            title="Đây là công ty nội bộ của MYSP"
            description="Khoá nó là khoá chính đội ngũ — mọi thành viên MYSP mất quyền vào."
          />
        ) : null}

        <TextArea
          label={`Lý do ${verb} ${target.name}`}
          description={`Bắt buộc, ít nhất ${SUSPEND_REASON_MIN} ký tự. Dòng này được lưu lại để đối chiếu về sau.`}
          isRequired
          rows={3}
          value={reason}
          onChange={(value) => {
            setReason(value);
            if (reasonError) setReasonError(null);
          }}
          status={reasonError ? { type: "error", message: reasonError } : undefined}
          statusVariant="detached"
        />

        <HStack gap={2} align="center" wrap="wrap">
          {/* Never disabled on empty: bấm được, rồi chỉ ra thiếu gì. */}
          <Button
            variant={isSuspended ? "primary" : "destructive"}
            label={`Xác nhận ${verb} ${target.name}`}
            onClick={submit}
          >
            {isSuspended ? "Mở khoá công ty" : "Khoá công ty"}
          </Button>
          <Button variant="ghost" label={`Không ${verb} ${target.name}`} onClick={onCancel}>
            Giữ nguyên
          </Button>
        </HStack>
      </Stack>
    </Dialog>
  );
}
