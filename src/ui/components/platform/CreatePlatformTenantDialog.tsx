"use client";

import {
  Banner,
  Button,
  Dialog,
  DialogHeader,
  HStack,
  Selector,
  Stack,
  Text,
  TextInput,
} from "@astryxdesign/core";
import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect, useState } from "react";
import { Controller, useForm } from "react-hook-form";

import { ApiErrorNotice } from "@/ui/components/feedback/ApiErrorNotice";
import { useCreatePlatformTenant } from "@/ui/hooks/usePlatformTenants";
import {
  CreatePlatformTenantFormSchema,
  PLATFORM_PLANS,
  PLATFORM_PLAN_LABELS,
  isCreatePlatformTenantField,
  type CreatePlatformTenantFormValues,
  type CreatePlatformTenantResponse,
} from "@/ui/schemas/platform.schema";
import { formatDateTime } from "@/ui/schemas/post-batch.schema";
import { ApiError } from "@/ui/services/api-error";

/**
 * "Tạo công ty cho khách" (M3.2) — MYSP sets a customer up, then hands them the
 * owner link.
 *
 * Two screens in one dialog, on purpose: the form, and then the ONE sighting of
 * `ownerInviteUrl`. Closing before copying loses the link for good, so the
 * dialog refuses to close by backdrop while it is showing (`purpose="form"`)
 * and says out loud what is about to be lost.
 *
 * SECURITY: the url is a credential (whoever opens it owns a brand-new
 * company). It lives in the mutation's answer, in memory, and is never stored,
 * keyed or logged — same treatment as the invite links in M2.3.
 */
export function CreatePlatformTenantDialog({
  isOpen,
  onOpenChange,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const create = useCreatePlatformTenant();

  function close() {
    create.reset();
    onOpenChange(false);
  }

  return (
    <Dialog
      isOpen={isOpen}
      onOpenChange={(open) => {
        // Never yank the dialog away mid-request, and never while the link is
        // the only copy in existence — that is what the explicit button is for.
        if (!open && (create.isPending || create.isSuccess)) return;
        if (!open) close();
      }}
      purpose="form"
      width={560}
    >
      <DialogHeader
        title="Tạo công ty cho khách"
        subtitle="Tạo sẵn công ty rồi gửi link mời chủ sở hữu cho khách."
        onOpenChange={create.isPending || create.isSuccess ? undefined : () => close()}
      />
      <Stack direction="vertical" gap={3} padding={4}>
        {create.isSuccess ? (
          <OwnerInviteReveal result={create.data} onDone={close} />
        ) : (
          <CreateForm
            onSubmit={(values) => create.mutate(values)}
            isPending={create.isPending}
            error={create.isError ? create.error : null}
            onCancel={close}
          />
        )}
      </Stack>
    </Dialog>
  );
}

function CreateForm({
  onSubmit,
  isPending,
  error,
  onCancel,
}: {
  onSubmit: (values: CreatePlatformTenantFormValues) => void;
  isPending: boolean;
  error: unknown;
  onCancel: () => void;
}) {
  const form = useForm<CreatePlatformTenantFormValues>({
    resolver: zodResolver(CreatePlatformTenantFormSchema),
    mode: "onTouched",
    reValidateMode: "onChange",
    defaultValues: { name: "", slug: "", plan: "" },
  });

  /**
   * Server-side validation belongs on the fields it names — including
   * SLUG_TAKEN, which is about one box. Anything reported on a field this form
   * does not own stays in `<ApiErrorNotice>`; nothing is dropped (rule 5).
   */
  useEffect(() => {
    if (!ApiError.is(error)) return;

    if (error.code === "SLUG_TAKEN") {
      form.setError("slug", { type: "server", message: error.userMessage });
      form.setFocus("slug");
      return;
    }

    const issues = (error.issues ?? []).filter((issue) =>
      isCreatePlatformTenantField(issue.path),
    );
    for (const issue of issues) {
      form.setError(issue.path as "name" | "slug" | "plan", {
        type: "server",
        message: issue.message,
      });
    }
    const first = issues[0];
    if (first) form.setFocus(first.path as "name" | "slug" | "plan");
  }, [error, form]);

  const isFieldOnlyError =
    ApiError.is(error) &&
    (error.code === "SLUG_TAKEN" || (error.issues ?? []).length > 0) &&
    (error.issues ?? []).every((issue) => isCreatePlatformTenantField(issue.path));

  return (
    // A real <form>: Enter submits and assistive tech announces it as one
    // thing being sent. Astryx has no form primitive, so this is the only raw
    // element here. `noValidate`: the messages come from zod, and two sources
    // for one error is how a field says two different things.
    <form noValidate onSubmit={form.handleSubmit((values) => onSubmit(values))}>
      <Stack direction="vertical" gap={3}>
        <Controller
          control={form.control}
          name="name"
          render={({ field, fieldState }) => (
            <TextInput
              label="Tên công ty"
              description="Tên khách nhìn thấy trên thanh trên cùng."
              placeholder="Nhà Xe An Anh"
              isRequired
              hasAutoFocus
              isDisabled={isPending}
              value={field.value}
              onChange={field.onChange}
              status={
                fieldState.error ? { type: "error", message: fieldState.error.message } : undefined
              }
              statusVariant="detached"
            />
          )}
        />

        <Controller
          control={form.control}
          name="slug"
          render={({ field, fieldState }) => (
            <TextInput
              label="Đường dẫn"
              description="Bỏ trống để máy chủ tự sinh từ tên công ty."
              placeholder="nha-xe-an-anh"
              isOptional
              isDisabled={isPending}
              value={field.value}
              onChange={field.onChange}
              status={
                fieldState.error ? { type: "error", message: fieldState.error.message } : undefined
              }
              statusVariant="detached"
            />
          )}
        />

        <Controller
          control={form.control}
          name="plan"
          render={({ field, fieldState }) => (
            // A picker, not a text box: the server takes exactly two codes
            // (`PlatformCreateTenantRecord.plan`), so a typed one could only
            // ever come back as a 400.
            <Selector
              label="Gói"
              description="Bỏ trống để dùng gói mặc định của hệ thống."
              placeholder="Gói mặc định"
              isOptional
              hasClear
              isDisabled={isPending}
              options={PLATFORM_PLANS.map((plan) => ({
                value: plan,
                label: PLATFORM_PLAN_LABELS[plan],
              }))}
              // `null`, not `undefined`: this Selector is controlled, and null is
              // how it says "chưa chọn" (an undefined value would make it
              // uncontrolled and drop the operator's clear action).
              value={field.value.length > 0 ? field.value : null}
              // `hasClear` hands back null at runtime while the prop type says
              // string — `?? ""` covers the gap without widening the signature.
              onChange={(value: string | null) => field.onChange(value ?? "")}
              status={
                fieldState.error ? { type: "error", message: fieldState.error.message } : undefined
              }
              statusVariant="detached"
            />
          )}
        />

        {error && !isFieldOnlyError ? <ApiErrorNotice error={error} operation="platform" /> : null}

        <HStack gap={2} align="center" wrap="wrap">
          {/* Never disabled on invalid: bấm được, rồi chỉ ra lỗi ở đâu. */}
          <Button
            type="submit"
            variant="primary"
            label="Tạo công ty"
            isLoading={isPending}
            isDisabled={isPending}
          />
          <Button
            type="button"
            variant="ghost"
            label="Huỷ"
            isDisabled={isPending}
            onClick={onCancel}
          />
        </HStack>

        <Text type="supporting" role="status" aria-live="polite">
          {isPending ? "Đang tạo công ty, vui lòng đợi" : ""}
        </Text>
      </Stack>
    </form>
  );
}

type CopyState = "idle" | "copied" | "failed";

/** The one and only sighting of the owner link. */
function OwnerInviteReveal({
  result,
  onDone,
}: {
  result: CreatePlatformTenantResponse;
  onDone: () => void;
}) {
  const [state, setState] = useState<CopyState>("idle");

  useEffect(() => {
    if (state === "idle") return;
    const timer = setTimeout(() => setState("idle"), 4_000);
    return () => clearTimeout(timer);
  }, [state]);

  async function copy() {
    if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
      // Never the url itself in a log line — it is a credential.
      console.error("[platform] clipboard unavailable", {
        tenant_id: result.tenant.id,
        error_code: "CLIPBOARD_UNAVAILABLE",
      });
      setState("failed");
      return;
    }
    try {
      await navigator.clipboard.writeText(result.ownerInviteUrl);
      setState("copied");
    } catch (error) {
      // Never swallow: without this the button would look like it worked.
      console.error("[platform] copy owner invite failed", {
        tenant_id: result.tenant.id,
        error_code: "CLIPBOARD_DENIED",
        err: error,
      });
      setState("failed");
    }
  }

  return (
    <Stack direction="vertical" gap={3}>
      <Banner
        status="success"
        role="status"
        title={`Đã tạo ${result.tenant.name}`}
        description={`Link mời chủ sở hữu chỉ hiện lần này — chép và gửi cho khách ngay. Hết hạn ${formatDateTime(result.inviteExpiresAt)}.`}
      />

      {/* Read-only rather than plain text: it stays selectable with the
          keyboard, which is the fallback when the clipboard is blocked. */}
      <TextInput
        label="Link mời chủ sở hữu"
        isReadOnly
        value={result.ownerInviteUrl}
        onChange={() => undefined}
        width="100%"
      />

      <HStack gap={2} align="center" wrap="wrap">
        <Button variant="secondary" label="Chép link" onClick={() => void copy()} />
        <Button variant="primary" label="Đã chép xong, đóng" onClick={onDone} />
      </HStack>

      <Text type="supporting" role="status" aria-live="polite">
        {state === "copied" ? "Đã chép link vào clipboard." : ""}
        {state === "failed"
          ? "Trình duyệt không cho chép tự động — hãy bôi đen link ở trên rồi chép tay."
          : ""}
      </Text>
    </Stack>
  );
}
