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

/** Shown as the confirm button's tooltip while its write is in flight. */
const SAVING_MESSAGE = "Đang lưu thay đổi cho công ty này…";

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
  isBusy,
  onCancel,
  onConfirm,
}: {
  /** The row being confirmed. The caller mounts this only when it has one. */
  tenant: PlatformTenant;
  /** This row's lock/unlock write is in flight — the confirm button is spent. */
  isBusy: boolean;
  onCancel: () => void;
  onConfirm: (tenant: PlatformTenant, reason: string) => void;
}) {
  const [reason, setReason] = useState("");
  const [reasonError, setReasonError] = useState<string | null>(null);

  const isSuspended = tenant.status === "suspended";
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
    onConfirm(tenant, parsed.data.reason);
  }

  return (
    <Dialog isOpen onOpenChange={(open) => (open ? undefined : onCancel())} purpose="form" width={560}>
      <DialogHeader
        title={isSuspended ? `Mở khoá ${tenant.name}` : `Khoá ${tenant.name}`}
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
            ? `Mở khoá ${tenant.name}? ${activateConsequence(tenant)}`
            : `Khoá ${tenant.name}? ${suspendConsequence(tenant)}`}
        </Text>

        {/* The one row where "khoá công ty này" means "khoá chính chúng ta" —
            worth its own band here, where there is room to say it. */}
        {!isSuspended && isInternalTenant(tenant) ? (
          <Banner
            status="warning"
            title="Đây là công ty nội bộ của MYSP"
            description="Khoá nó là khoá chính đội ngũ — mọi thành viên MYSP mất quyền vào."
          />
        ) : null}

        <TextArea
          label={`Lý do ${verb} ${tenant.name}`}
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
          {/* Never disabled on an empty box: it stays pressable and then says
              what is missing. The ONLY thing that spends it is this row's own
              write already being in flight — locking a company twice is not a
              double click anyone should be able to make. `tooltip` is load
              bearing there: Astryx only swaps native `disabled` for
              `aria-disabled` when a tooltip is present (Button.js), and a
              natively disabled button that had focus drops the keyboard on
              <body> — inside a modal, that is the worst place for it. */}
          <Button
            variant={isSuspended ? "primary" : "destructive"}
            label={`Xác nhận ${verb} ${tenant.name}`}
            isLoading={isBusy}
            isDisabled={isBusy}
            tooltip={isBusy ? SAVING_MESSAGE : undefined}
            onClick={submit}
          >
            {isSuspended ? "Mở khoá công ty" : "Khoá công ty"}
          </Button>
          <Button variant="ghost" label={`Không ${verb} ${tenant.name}`} onClick={onCancel}>
            Giữ nguyên
          </Button>
        </HStack>
      </Stack>
    </Dialog>
  );
}
