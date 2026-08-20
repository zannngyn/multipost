"use client";

import { Button, HStack, Stack, Text, TextInput } from "@astryxdesign/core";
import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect, useRef } from "react";
import { Controller, useForm, useWatch } from "react-hook-form";

import { ApiErrorNotice } from "@/ui/components/feedback/ApiErrorNotice";
import {
  CreateTenantFormSchema,
  isCreateTenantField,
  slugify,
  type CreateTenantFormValues,
} from "@/ui/schemas/tenant-onboarding.schema";
import { ApiError } from "@/ui/services/api-error";

/**
 * "Tạo công ty của bạn" (M2.1).
 *
 * Presentational by contract (core-form-architecture): it validates and hands
 * the values up through `onSubmit`; it never calls the API itself, which is why
 * the same form serves the first-run screen and the dialog behind "Tạo công ty
 * mới…" in the switcher.
 *
 * The slug follows the name until the operator touches it. That is the whole
 * point of a preview: someone typing "Nhà Xe An Anh" should not have to know
 * what a URL segment is, and someone who does care must not have their edit
 * overwritten on the next keystroke.
 *
 * Astryx `TextInput` is a controlled component with no `ref`, so the fields go
 * through `Controller` — the documented exception to uncontrolled-by-default.
 */
export function CreateTenantForm({
  onSubmit,
  isPending,
  error,
  onCancel,
  hasAutoFocus = false,
  submitLabel = "Tạo công ty",
}: {
  onSubmit: (values: CreateTenantFormValues) => void;
  isPending: boolean;
  /** Server refusal for THIS submit; field issues land on their fields. */
  error: unknown;
  onCancel?: () => void;
  hasAutoFocus?: boolean;
  submitLabel?: string;
}) {
  const form = useForm<CreateTenantFormValues>({
    resolver: zodResolver(CreateTenantFormSchema),
    // Nothing turns red while the operator is still typing the first word.
    mode: "onTouched",
    reValidateMode: "onChange",
    defaultValues: { name: "", slug: "" },
  });

  const name = useWatch({ control: form.control, name: "name" }) ?? "";
  /** True once the operator edits the slug — from then on it is theirs. */
  const isSlugOwnedByUser = useRef(false);

  // Keeping the preview in sync is a side effect of typing in ANOTHER field, so
  // it cannot be expressed as a default value.
  useEffect(() => {
    if (isSlugOwnedByUser.current) return;
    const preview = slugify(name);
    // `shouldDirty: false`: the operator did not type this, so it must not make
    // the form look edited (core-form-architecture §dirty).
    form.setValue("slug", preview, { shouldDirty: false, shouldValidate: false });
  }, [name, form]);

  /**
   * Server-side validation belongs on the fields it names — including
   * SLUG_TAKEN, which is about one box and nothing else. Anything the server
   * reports on a field this form does not own stays in `<ApiErrorNotice>`; it
   * is never dropped (CLAUDE.md rule 5).
   */
  useEffect(() => {
    if (!ApiError.is(error)) return;

    if (error.code === "SLUG_TAKEN") {
      form.setError("slug", { type: "server", message: error.userMessage });
      form.setFocus("slug");
      return;
    }

    const fieldIssues = (error.issues ?? []).filter((issue) => isCreateTenantField(issue.path));
    for (const issue of fieldIssues) {
      form.setError(issue.path as "name" | "slug", { type: "server", message: issue.message });
    }
    const first = fieldIssues[0];
    if (first) form.setFocus(first.path as "name" | "slug");
  }, [error, form]);

  /** Field-level refusals are already on the fields; do not repeat them. */
  const isFieldOnlyError =
    ApiError.is(error) &&
    (error.code === "SLUG_TAKEN" ||
      (error.issues ?? []).length > 0) &&
    (error.issues ?? []).every((issue) => isCreateTenantField(issue.path));

  return (
    // A real <form>: Enter submits, the browser knows this is one thing being
    // sent, and assistive tech announces it as a form. Astryx has no form
    // primitive, so this is the one raw element here; every control inside it
    // is a component, and all spacing comes from Stack.
    // `noValidate`: the messages come from zod, and two sources of truth for
    // one error is how a field ends up saying two different things.
    <form noValidate onSubmit={form.handleSubmit((values) => onSubmit(values))}>
      <Stack direction="vertical" gap={3}>
        <Controller
          control={form.control}
          name="name"
          render={({ field, fieldState }) => (
            <TextInput
              label="Tên công ty"
              description="Tên hiện trên thanh trên cùng và trong mọi báo cáo."
              placeholder="Nhà Xe An Anh"
              isRequired
              hasAutoFocus={hasAutoFocus}
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
              description="Tự sinh từ tên công ty. Sửa được, chỉ gồm chữ thường, số và dấu gạch ngang."
              placeholder="nha-xe-an-anh"
              isDisabled={isPending}
              value={field.value}
              onChange={(value) => {
                // From the first keystroke here the preview stops following.
                isSlugOwnedByUser.current = true;
                field.onChange(value);
              }}
              status={
                fieldState.error ? { type: "error", message: fieldState.error.message } : undefined
              }
              statusVariant="detached"
            />
          )}
        />

        {/* Everything the fields cannot carry — limits, network, 5xx. */}
        {error && !isFieldOnlyError ? <ApiErrorNotice error={error} /> : null}

        <HStack gap={2} align="center" wrap="wrap">
          {/* Never disabled on invalid: an operator who bumps a dead button
              learns nothing. Bấm được, rồi chỉ ra lỗi ở đâu. */}
          <Button
            type="submit"
            variant="primary"
            label={submitLabel}
            isLoading={isPending}
            isDisabled={isPending}
          />
          {onCancel ? (
            <Button
              type="button"
              variant="ghost"
              label="Huỷ"
              isDisabled={isPending}
              onClick={onCancel}
            />
          ) : null}
        </HStack>

        <Text type="supporting" role="status" aria-live="polite">
          {isPending ? "Đang tạo công ty, vui lòng đợi" : ""}
        </Text>
      </Stack>
    </form>
  );
}
