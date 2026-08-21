"use client";

import {
  Banner,
  Button,
  CheckboxInput,
  FormLayout,
  HStack,
  Heading,
  Stack,
  Text,
  TextArea,
  TextInput,
} from "@astryxdesign/core";
import { zodResolver } from "@hookform/resolvers/zod";
import { useId, useMemo } from "react";
import { Controller, useForm, useWatch } from "react-hook-form";

import { ApiErrorNotice } from "@/ui/components/feedback/ApiErrorNotice";
import { PromptVariablesHelp } from "@/ui/components/prompts/PromptVariablesHelp";
import { ApiError } from "@/ui/services/api-error";
import {
  PromptVersionFormSchema,
  inspectPromptBody,
  type PromptVersionFormValues,
} from "@/ui/schemas/prompt.schema";

/**
 * "Tạo phiên bản mới" (E10.7). RHF + zod, one schema shared with the screen.
 *
 * Prompt rows are IMMUTABLE: this form never edits a version, it always creates
 * the next one. Prefilling it from an existing version is therefore the normal
 * way to "sửa" a prompt, and `changelog` is required because a version whose
 * reason nobody wrote down cannot be audited later.
 *
 * Every field is an Astryx input driven through `Controller` — they take
 * `value`/`onChange` rather than a ref, which is the one case
 * core-form-architecture allows a controlled field. Label sits above the input,
 * the message below it, and no placeholder stands in for a label.
 *
 * Variable problems are reported ON THE BODY FIELD, so the eye lands where the
 * fix is:
 *  - locally, as the field's `warning` status, while typing (advisory);
 *  - from the server, as the real refusal — the API returns one `issues` entry
 *    per offending variable, so the field turns red and the list of names sits
 *    right under it.
 */
export function PromptVersionForm({
  nextVersion,
  defaultValues,
  pending,
  error,
  warnings,
  onSubmit,
  onCancel,
}: {
  nextVersion: number;
  defaultValues?: Partial<PromptVersionFormValues>;
  pending: boolean;
  /** Server refusal for THIS form (INVALID_INPUT naming the variables). */
  error?: unknown;
  /** Non-blocking remarks from the last successful save. */
  warnings?: readonly string[];
  onSubmit: (values: PromptVersionFormValues) => void;
  onCancel?: () => void;
}) {
  const formId = useId();
  const headingId = `${formId}-heading`;
  const helpId = `${formId}-help`;

  const form = useForm<PromptVersionFormValues>({
    resolver: zodResolver(PromptVersionFormSchema),
    mode: "onSubmit",
    reValidateMode: "onChange",
    defaultValues: {
      name: defaultValues?.name ?? "",
      systemPrompt: defaultValues?.systemPrompt ?? "",
      body: defaultValues?.body ?? "",
      changelog: defaultValues?.changelog ?? "",
      activate: defaultValues?.activate ?? false,
    },
  });

  const body = useWatch({ control: form.control, name: "body" }) ?? "";
  const report = useMemo(() => inspectPromptBody(body), [body]);

  /** Server-side variable complaints, one line per variable. */
  const serverIssues = ApiError.is(error)
    ? (error.issues ?? []).filter((issue) => issue.path === "body")
    : [];

  const errors = form.formState.errors;

  /**
   * One status per field, in the order the operator should act on it: the
   * schema's refusal, then the server's, then the advisory remarks. Two
   * messages under one box is how a field ends up saying two things at once.
   */
  const bodyStatus: { type: "error" | "warning"; message?: string } | undefined = errors.body
    ? { type: "error", message: errors.body.message }
    : serverIssues.length > 0
      ? { type: "error" }
      : report.missing.length > 0
        ? {
            type: "warning",
            message: `Còn thiếu biến bắt buộc: ${report.missing.map((name) => `{{${name}}}`).join(", ")}.`,
          }
        : report.unknown.length > 0
          ? {
              type: "warning",
              message: `Biến không nằm trong danh sách cho phép: ${report.unknown
                .map((name) => `{{${name}}}`)
                .join(", ")}. Máy chủ sẽ từ chối lưu.`,
            }
          : undefined;

  return (
    // A real <form>: Enter submits and assistive tech announces it as one thing
    // being sent. `noValidate`: the messages come from zod, and two sources for
    // one error is how a field says two different things.
    <form noValidate onSubmit={form.handleSubmit((values) => onSubmit(values))} aria-labelledby={headingId}>
      <Stack direction="vertical" gap={4}>
        <Stack direction="vertical" gap={1} maxWidth={640}>
          <Heading id={headingId} level={3}>
            Tạo phiên bản mới (v{nextVersion})
          </Heading>
          <Text type="supporting">
            Phiên bản cũ không bị sửa hay xoá — mỗi lần lưu là một bản mới, để sau này còn truy được
            caption nào sinh ra từ prompt nào.
          </Text>
        </Stack>

        <FormLayout>
          <Controller
            control={form.control}
            name="name"
            render={({ field, fieldState }) => (
              <TextInput
                label="Tên phiên bản"
                description="Tên để nhận ra bản này trong danh sách."
                placeholder="Ví dụ: Giọng Tết 2027"
                isRequired
                isDisabled={pending}
                width="100%"
                value={field.value}
                onChange={field.onChange}
                onBlur={field.onBlur}
                status={
                  fieldState.error ? { type: "error", message: fieldState.error.message } : undefined
                }
                statusVariant="detached"
              />
            )}
          />

          <Controller
            control={form.control}
            name="systemPrompt"
            render={({ field, fieldState }) => (
              <TextArea
                label="System prompt"
                description="Vai trò và luật chung cho AI. Không dùng biến ở đây."
                isRequired
                rows={4}
                hasSpellCheck={false}
                isDisabled={pending}
                width="100%"
                value={field.value}
                onChange={field.onChange}
                onBlur={field.onBlur}
                status={
                  fieldState.error ? { type: "error", message: fieldState.error.message } : undefined
                }
                statusVariant="detached"
              />
            )}
          />

          <Controller
            control={form.control}
            name="body"
            render={({ field }) => (
              <TextArea
                label="Nội dung prompt"
                // The variables in use live in the field's own description so
                // they are read out with the field, not stranded beside it.
                description={`Dùng cú pháp {{tên_biến}}; danh sách biến hợp lệ ở khung bên dưới. Biến đang dùng: ${
                  report.variables.length > 0 ? report.variables.join(", ") : "(chưa có)"
                }.`}
                placeholder={"Viết caption cho sản phẩm {{product.name}}...\n\nRàng buộc: {{constraints}}"}
                isRequired
                rows={12}
                hasSpellCheck={false}
                isDisabled={pending}
                width="100%"
                value={field.value}
                onChange={field.onChange}
                onBlur={field.onBlur}
                status={bodyStatus}
                statusVariant="detached"
              />
            )}
          />

          {/* The server names one variable per line; they belong under the box
              they are about, not in a toast somewhere else. */}
          {serverIssues.length > 0 ? (
            <Banner
              status="error"
              role="alert"
              title="Máy chủ từ chối nội dung prompt"
              description={
                <Stack as="ul" direction="vertical" gap={0.5}>
                  {serverIssues.map((issue, index) => (
                    <HStack as="li" key={`${issue.message}-${index}`}>
                      <Text type="supporting">{issue.message}</Text>
                    </HStack>
                  ))}
                </Stack>
              }
            />
          ) : null}

          <Controller
            control={form.control}
            name="changelog"
            render={({ field, fieldState }) => (
              <TextArea
                label="Vì sao đổi (changelog)"
                description="Dấu vết để sau này truy lại vì sao caption đổi giọng."
                placeholder="Ví dụ: bỏ emoji ở câu mở, thêm nhắc size"
                isRequired
                rows={2}
                isDisabled={pending}
                width="100%"
                value={field.value}
                onChange={field.onChange}
                onBlur={field.onBlur}
                status={
                  fieldState.error ? { type: "error", message: fieldState.error.message } : undefined
                }
                statusVariant="detached"
              />
            )}
          />

          <Controller
            control={form.control}
            name="activate"
            render={({ field }) => (
              <CheckboxInput
                label="Kích hoạt ngay sau khi lưu"
                description="Bỏ tick để lưu thành bản nháp và kích hoạt sau. Kích hoạt đổi prompt cho MỌI caption sinh sau đó — caption đã sinh không bị ảnh hưởng."
                isDisabled={pending}
                value={field.value}
                onChange={(checked) => field.onChange(checked)}
              />
            )}
          />
        </FormLayout>

        <PromptVariablesHelp id={helpId} />

        {warnings && warnings.length > 0 ? (
          <Banner
            status="warning"
            role="status"
            title="Đã lưu, kèm lưu ý"
            description={
              <Stack as="ul" direction="vertical" gap={0.5}>
                {warnings.map((warning) => (
                  <HStack as="li" key={warning}>
                    <Text type="supporting">{warning}</Text>
                  </HStack>
                ))}
              </Stack>
            }
          />
        ) : null}

        {/* The whole refusal (code + sentence); the per-variable lines are above. */}
        {error ? <ApiErrorNotice error={error} /> : null}

        <HStack gap={2} align="center" wrap="wrap">
          {/* Never disabled on invalid: bấm được, rồi chỉ ra lỗi ở đâu. */}
          <Button
            type="submit"
            variant="primary"
            label={`Lưu phiên bản v${nextVersion}`}
            isLoading={pending}
            isDisabled={pending}
          >
            {pending ? "Đang lưu…" : `Lưu phiên bản v${nextVersion}`}
          </Button>
          {onCancel ? (
            <Button
              type="button"
              variant="ghost"
              label="Huỷ tạo phiên bản mới"
              isDisabled={pending}
              onClick={onCancel}
            >
              Huỷ
            </Button>
          ) : null}
        </HStack>

        <Text type="supporting" role="status" aria-live="polite">
          {pending ? "Đang lưu phiên bản mới, vui lòng đợi" : ""}
        </Text>
      </Stack>
    </form>
  );
}
