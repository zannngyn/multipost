"use client";

import {
  Banner,
  Button,
  Divider,
  HStack,
  Heading,
  Section,
  Stack,
  Text,
  TextArea,
  TextInput,
} from "@astryxdesign/core";
import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect } from "react";
import { Controller, useForm, useWatch } from "react-hook-form";

import { ApiErrorNotice } from "@/ui/components/feedback/ApiErrorNotice";
import { ReadOnlyNotice } from "@/ui/components/feedback/ReadOnlyNotice";
import {
  EMPTY_MANUAL_PRODUCT,
  MANUAL_PRODUCT_LIMITS,
  ManualProductFormSchema,
  isManualProductField,
  type ManualProductField,
  type ManualProductFormValues,
} from "@/ui/schemas/manual-product.schema";
import { ApiError } from "@/ui/services/api-error";

/**
 * "Nhập tay thông tin sản phẩm" — onboarding phase 3, the bottom rung of the
 * whole feature: a customer whose data is too dirty to import, or who has no
 * Google Workspace at all, still has to be able to publish.
 *
 * THREE THINGS THIS COMPONENT IS RESPONSIBLE FOR
 *
 * 1. Saying, BEFORE the first keystroke, that typing a product is not a way
 *    round the stock gate. The red banner is the first thing in the form and it
 *    is not dismissable, because the rule it states does not go away by being
 *    acknowledged. Letting somebody fill in six fields and only then discover
 *    that an empty stock box means "không đăng được" is the exact shape of
 *    unpleasant surprise CLAUDE.md rule 5 exists to prevent.
 *
 * 2. Holding the whitelist open to inspection. The four caption fields sit in
 *    one group under their own heading, the two internal ones in another under
 *    a heading that says they never reach a caption (business rule 2). There is
 *    NO free-text "ghi chú thêm" box: the server schema is a `z.strictObject`,
 *    so a seventh field would not be a nice extra — it would be a 400 for the
 *    whole post, and, worse, a door for a price to walk into a prompt.
 *
 * 3. Never losing what was typed. A refusal — hết hàng, mã đã có trong dữ liệu
 *    đồng bộ, một ô quá dài — leaves every value on screen with the reason
 *    beside it (core-form-architecture §hợp đồng lỗi).
 *
 * Presentational by contract: it validates and hands the values up through
 * `onSubmit`. It never composes, never fetches, and never decides whether the
 * post may go out — the server owns all three.
 *
 * Astryx `TextInput`/`TextArea` are controlled and take no `ref`, so the fields
 * go through `Controller`, the documented exception to uncontrolled-by-default.
 */
export function ManualProductForm({
  productCode,
  defaultValues = EMPTY_MANUAL_PRODUCT,
  onSubmit,
  onCancel,
  isPending,
  error,
  readOnlyReason,
  isEditing = false,
}: {
  /** The code these fields belong to; it is NOT one of them (see the schema). */
  productCode: string;
  defaultValues?: ManualProductFormValues;
  onSubmit: (values: ManualProductFormValues) => void;
  /** "Thôi, dùng dữ liệu đã đồng bộ" — back to a plain lookup. */
  onCancel: () => void;
  isPending: boolean;
  /** The refusal of the LAST lookup; field issues land on their own boxes. */
  error: unknown;
  readOnlyReason: string | null;
  /** True when a typed product is already on screen and this is a re-edit. */
  isEditing?: boolean;
}) {
  const form = useForm<ManualProductFormValues>({
    resolver: zodResolver(ManualProductFormSchema),
    // Nothing turns red while the first word is still being typed.
    mode: "onTouched",
    reValidateMode: "onChange",
    defaultValues,
  });

  /**
   * A server refusal belongs on the box it names. Anything the server reports
   * on a field this form does not own stays in `<ApiErrorNotice>` below — it is
   * never dropped (CLAUDE.md rule 5).
   *
   * The paths arrive as `manualProduct.name` from the route's body schema and as
   * plain `name` from `buildManualProduct`, which reports on the object it was
   * handed. Both are accepted rather than picking one and silently losing the
   * other.
   */
  useEffect(() => {
    if (!ApiError.is(error)) return;

    const fieldIssues = (error.issues ?? [])
      .map((issue) => ({
        path: issue.path.replace(/^manualProduct\./, ""),
        message: issue.message,
      }))
      .filter((issue) => isManualProductField(issue.path));

    for (const issue of fieldIssues) {
      form.setError(issue.path as ManualProductField, { type: "server", message: issue.message });
    }
    const first = fieldIssues[0];
    if (first) form.setFocus(first.path as ManualProductField);
  }, [error, form]);

  /** Every issue landed on a box; repeating them in a banner would be noise. */
  const isFieldOnlyError =
    ApiError.is(error) &&
    (error.issues ?? []).length > 0 &&
    (error.issues ?? []).every((issue) =>
      isManualProductField(issue.path.replace(/^manualProduct\./, "")),
    );

  const stockRaw = useWatch({ control: form.control, name: "stockRaw" }) ?? "";
  const isStockEmpty = stockRaw.trim().length === 0;
  const isBlocked = isPending || Boolean(readOnlyReason);

  return (
    <Section variant="muted" padding={3}>
      <Stack direction="vertical" gap={3}>
        <Stack direction="vertical" gap={1}>
          {/*
            The code is NOT one of the six fields (it comes from the box above),
            so it is named here instead — this form must never look like a place
            to type a code, and it must never name a product other than the one
            the button will compose. An empty code is possible for exactly one
            frame while the box above is being retyped; the heading degrades
            rather than reading "…sản phẩm  ".
          */}
          <Heading level={3}>
            {productCode.trim().length > 0
              ? `Nhập tay thông tin sản phẩm ${productCode.trim()}`
              : "Nhập tay thông tin sản phẩm"}
          </Heading>
          <Text type="supporting">
            Dùng khi mã này chưa có trong dữ liệu sản phẩm đã đồng bộ. Thông tin bạn nhập được lưu
            lại cho mã này và dùng để viết caption cho bài đăng.
          </Text>
        </Stack>

        {/*
          FIRST, and not dismissable: business rule 3 (kiểm tồn hai lần) applies
          to a typed product exactly as it applies to a synced row. An operator
          must read this before they decide what to put in the stock box, not
          after the server has refused the post.
        */}
        <Banner
          status="error"
          title="Nhập tay KHÔNG bỏ qua kiểm tồn kho"
          description="Bỏ trống ô “Tồn” thì hệ thống chặn đăng bài này — giống hệt một dòng trên bảng dữ liệu bị trống ô tồn. Ghi “HẾT HÀNG” ở ô Lưu ý cũng chặn. Chỉ đơn vị đã khai tắt kiểm tồn mới đăng được khi không có số tồn."
        />

        <ReadOnlyNotice reason={readOnlyReason} />

        {/*
          A real <form>: Enter submits and assistive tech announces it as one
          thing being sent. It is rendered OUTSIDE the lookup form on the compose
          screen — HTML forbids nesting one form in another, and a nested one
          would submit the wrong thing.
          `noValidate`: the messages come from zod, and two sources of truth for
          one error is how a box ends up saying two different things.
        */}
        <form noValidate onSubmit={form.handleSubmit((values) => onSubmit(values))}>
          <Stack direction="vertical" gap={3}>
            <Stack direction="vertical" gap={0.5}>
              <Heading level={4}>Thông tin vào caption</Heading>
              <Text type="supporting">
                Bốn ô này là tất cả những gì AI được đọc để viết bài. Không có ô nào khác, và giá
                thì không bao giờ.
              </Text>
            </Stack>

            <Controller
              control={form.control}
              name="name"
              render={({ field, fieldState }) => (
                <TextInput
                  label="Tên sản phẩm"
                  description="Caption luôn mở đầu bằng tên này."
                  placeholder="Váy hoa nhí tay bồng"
                  isRequired
                  hasAutoFocus={!isEditing}
                  isDisabled={isBlocked}
                  value={field.value}
                  onChange={field.onChange}
                  onBlur={field.onBlur}
                  status={
                    fieldState.error
                      ? { type: "error", message: fieldState.error.message }
                      : undefined
                  }
                  statusVariant="detached"
                />
              )}
            />

            <HStack gap={3} wrap="wrap" align="start">
              <Controller
                control={form.control}
                name="category"
                render={({ field, fieldState }) => (
                  <TextInput
                    label="Chủng loại"
                    description="Ví dụ: Váy, Áo sơ mi."
                    isOptional
                    isDisabled={isBlocked}
                    value={field.value}
                    onChange={field.onChange}
                    onBlur={field.onBlur}
                    status={
                      fieldState.error
                        ? { type: "error", message: fieldState.error.message }
                        : undefined
                    }
                    statusVariant="detached"
                  />
                )}
              />

              <Controller
                control={form.control}
                name="season"
                render={({ field, fieldState }) => (
                  <TextInput
                    label="Mùa vụ"
                    description="Ví dụ: Hè 2026."
                    isOptional
                    isDisabled={isBlocked}
                    value={field.value}
                    onChange={field.onChange}
                    onBlur={field.onBlur}
                    status={
                      fieldState.error
                        ? { type: "error", message: fieldState.error.message }
                        : undefined
                    }
                    statusVariant="detached"
                  />
                )}
              />
            </HStack>

            <Controller
              control={form.control}
              name="description"
              render={({ field, fieldState }) => (
                <TextArea
                  label="Mô tả"
                  description="Chất liệu, kiểu dáng, size — những gì bạn muốn khách đọc. Không ghi giá."
                  isOptional
                  rows={4}
                  maxLength={MANUAL_PRODUCT_LIMITS.description}
                  isDisabled={isBlocked}
                  value={field.value}
                  onChange={field.onChange}
                  onBlur={field.onBlur}
                  status={
                    fieldState.error
                      ? { type: "error", message: fieldState.error.message }
                      : undefined
                  }
                  statusVariant="detached"
                />
              )}
            />

            <Divider />

            <Stack direction="vertical" gap={0.5}>
              <Heading level={4}>Thông tin nội bộ</Heading>
              <Text type="supporting">
                Hai ô này quyết định bài có được đăng hay không. Chúng không bao giờ xuất hiện trong
                caption và không được gửi cho AI.
              </Text>
            </Stack>

            <HStack gap={3} wrap="wrap" align="start">
              <Controller
                control={form.control}
                name="stockRaw"
                render={({ field, fieldState }) => (
                  <TextInput
                    label="Tồn"
                    description="Số lượng còn lại, ví dụ: 12."
                    placeholder="12"
                    isDisabled={isBlocked}
                    value={field.value}
                    onChange={field.onChange}
                    onBlur={field.onBlur}
                    /*
                      A WARNING, not an error, and it shows the moment the box is
                      empty rather than waiting for a blur: it is stating a rule,
                      not judging what was typed. It is deliberately not a
                      client-side `required` — a tenant running
                      `stockPolicy.mode = "disabled"` may legitimately post with
                      no number, and this form cannot know whether that is the
                      case. The server decides; this only warns.
                    */
                    status={
                      fieldState.error
                        ? { type: "error", message: fieldState.error.message }
                        : isStockEmpty
                          ? {
                              type: "warning",
                              message: "Để trống thì bài này sẽ bị chặn đăng.",
                            }
                          : undefined
                    }
                    statusVariant="detached"
                  />
                )}
              />

              <Controller
                control={form.control}
                name="noteRaw"
                render={({ field, fieldState }) => (
                  <TextInput
                    label="Lưu ý"
                    description="Ghi “HẾT HÀNG” ở đây là chặn đăng mã này."
                    isOptional
                    isDisabled={isBlocked}
                    value={field.value}
                    onChange={field.onChange}
                    onBlur={field.onBlur}
                    status={
                      fieldState.error
                        ? { type: "error", message: fieldState.error.message }
                        : undefined
                    }
                    statusVariant="detached"
                  />
                )}
              />
            </HStack>

            {/*
              Not a field-level issue: hết hàng, mã đã có trong dữ liệu đồng bộ,
              hệ thống chưa bật nhập tay. No retry button — `presentApiError`
              already refuses one for a 4xx, and re-sending the same values would
              produce the same refusal.
            */}
            {error && !isFieldOnlyError ? (
              <ApiErrorNotice error={error} shouldFocus={false} source="Nhập tay sản phẩm" />
            ) : null}

            <HStack gap={2} wrap="wrap" align="center">
              {/*
                Never disabled by `isValid` (core-form-architecture): a button
                that does nothing teaches nothing. Pressing it with an empty name
                shows the error and moves focus there.
              */}
              <Button
                type="submit"
                variant="primary"
                label={isEditing ? "Cập nhật và tra lại" : "Dùng thông tin này"}
                isLoading={isPending}
                isDisabled={isBlocked}
                tooltip={readOnlyReason ?? undefined}
              />
              <Button
                type="button"
                variant="ghost"
                label={isEditing ? "Bỏ nhập tay" : "Thôi, không nhập tay"}
                isDisabled={isPending}
                onClick={onCancel}
              />
            </HStack>

            <Text type="supporting">
              Sau khi bấm, hệ thống vẫn kiểm tồn kho rồi mới gom ảnh. Mã này chưa có ảnh trên Drive
              thì đổi “Nguồn ảnh” sang “Tự tải file lên” và tải ảnh trước.
            </Text>
          </Stack>
        </form>
      </Stack>
    </Section>
  );
}
