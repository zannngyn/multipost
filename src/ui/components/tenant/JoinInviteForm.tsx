"use client";

import { Button, HStack, Stack, Text, TextInput } from "@astryxdesign/core";
import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect } from "react";
import { Controller, useForm } from "react-hook-form";

import { ApiErrorNotice } from "@/ui/components/feedback/ApiErrorNotice";
import {
  INVITE_FIELD_PATH,
  JoinInviteFormSchema,
  type JoinInviteFormValues,
} from "@/ui/schemas/tenant-onboarding.schema";
import { ApiError } from "@/ui/services/api-error";

/**
 * "Có link mời? Dán vào đây" (M2.1).
 *
 * One box that takes either a full invite link or the bare token inside it —
 * that is what is actually in someone's clipboard. The extraction rule lives in
 * `parseInviteToken`, shared with `/join/[token]`, so the two paths cannot
 * disagree about what a token is.
 *
 * Presentational: it validates and reports upward; the request belongs to the
 * caller (core-form-architecture).
 */
export function JoinInviteForm({
  onSubmit,
  isPending,
  error,
}: {
  onSubmit: (values: JoinInviteFormValues) => void;
  isPending: boolean;
  error: unknown;
}) {
  const form = useForm<JoinInviteFormValues>({
    resolver: zodResolver(JoinInviteFormSchema),
    mode: "onTouched",
    reValidateMode: "onChange",
    defaultValues: { invite: "" },
  });

  // A token THIS side could not read is reported on the box that holds it. A
  // token the server refuses arrives as 404 INVITE_INVALID and belongs in the
  // notice below, not on the field — there is nothing to fix by retyping.
  useEffect(() => {
    if (!ApiError.is(error)) return;
    const issue = (error.issues ?? []).find((item) => item.path === INVITE_FIELD_PATH);
    if (!issue) return;
    form.setError("invite", { type: "server", message: issue.message });
    form.setFocus("invite");
  }, [error, form]);

  const isFieldOnlyError =
    ApiError.is(error) && (error.issues ?? []).some((issue) => issue.path === INVITE_FIELD_PATH);

  return (
    // Raw <form> for the same reason as CreateTenantForm: Enter must submit,
    // and Astryx has no form primitive to wrap it in.
    <form noValidate onSubmit={form.handleSubmit((values) => onSubmit(values))}>
      <Stack direction="vertical" gap={3}>
        <Controller
          control={form.control}
          name="invite"
          render={({ field, fieldState }) => (
            <TextInput
              label="Link mời"
              description="Dán nguyên link bạn nhận được, hoặc riêng mã mời trong link đó."
              placeholder="https://mysp.vn/join/…"
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

        {error && !isFieldOnlyError ? <ApiErrorNotice error={error} /> : null}

        <HStack gap={2} align="center" wrap="wrap">
          <Button
            type="submit"
            variant="secondary"
            label="Vào công ty bằng link mời"
            isLoading={isPending}
            isDisabled={isPending}
          />
        </HStack>

        <Text type="supporting" role="status" aria-live="polite">
          {isPending ? "Đang kiểm tra link mời, vui lòng đợi" : ""}
        </Text>
      </Stack>
    </form>
  );
}
