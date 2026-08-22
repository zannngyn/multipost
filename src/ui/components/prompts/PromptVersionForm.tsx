"use client";

import {
  Button,
  CheckboxInput,
  Collapsible,
  Divider,
  HStack,
  Heading,
  Stack,
  Text,
  TextArea,
  TextInput,
} from "@astryxdesign/core";
import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect, useId, useMemo } from "react";
import { Controller, useForm, useWatch } from "react-hook-form";

import { ApiErrorNotice } from "@/ui/components/feedback/ApiErrorNotice";
/**
 * Said by every control that goes quiet during a save. Load-bearing mechanically
 * as well as in words — see `prompt-busy.ts`.
 */
import { SAVING_THIS_VERSION as SAVING_MESSAGE } from "@/ui/components/prompts/prompt-busy";
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
 * The panel opens INLINE under the button that asked for it (wave 2), so the
 * first field takes focus on mount (`hasAutoFocus`) — the operator carries on
 * typing where they clicked instead of hunting down the page. The variable
 * reference sits in a closed disclosure for the same reason: an eleven-line
 * whitelist between the fields and the save button pushes the panel back to
 * being a page of its own.
 *
 * Variable errors are shown INLINE under the body, naming the variables:
 *  - locally, as a warning, while typing (advisory);
 *  - from the server, as the real refusal — the API returns one `issues` entry
 *    per offending variable, and those win.
 *
 * Astryx fields are controlled, so every input goes through `Controller`: the
 * schema and the messages stay exactly where they were.
 */

export function PromptVersionForm({
  nextVersion,
  defaultValues,
  pending,
  blockedReason = null,
  error,
  firstFieldRef,
  onDirtyChange,
  onSubmit,
  onCancel,
}: {
  nextVersion: number;
  defaultValues?: Partial<PromptVersionFormValues>;
  /**
   * BUSY, not read-only: a save of this panel's own is in flight. It puts EVERY
   * field and BOTH buttons out of action for the length of the request — each
   * one saying so through `disabledMessage`/`tooltip`, which is also what keeps
   * them focusable (Astryx only swaps native `disabled` for `aria-disabled`
   * when there is a message to reach). It never unmounts anything and never
   * changes a sentence (`prompt-write-access.ts`).
   */
  pending: boolean;
  /**
   * Why this form may not be SUBMITTED right now, although nothing of its own
   * is in flight — currently: an activation is running elsewhere on the screen.
   *
   * The reverse of `pending`, and deliberately narrower. "Lưu" can carry
   * `activate: true`, so a save landing during an activation makes two answers
   * to "bản nào đang chạy" and the last response wins — the exact race the
   * table already refuses in the other direction. The fields stay live: typing
   * is not a write, and taking the panel away from someone mid-sentence to
   * report a request they did not start is a worse trade than a locked button.
   */
  blockedReason?: string | null;
  /** Server refusal for THIS form (INVALID_INPUT naming the variables). */
  error?: unknown;
  /**
   * Handle on the first field so the screen can put focus back after Astryx's
   * dialog has restored it elsewhere. `hasAutoFocus` covers the normal open.
   */
  firstFieldRef?: React.RefObject<HTMLInputElement | null>;
  /**
   * Reports whether anything has been typed since the panel opened. The screen
   * needs it to know when replacing the draft would destroy real work — the
   * form owns the field state, so only it can answer.
   */
  onDirtyChange?: (isDirty: boolean) => void;
  onSubmit: (values: PromptVersionFormValues) => void;
  onCancel?: () => void;
}) {
  const formId = useId();
  const headingId = `${formId}-heading`;

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

  // `isDirty` is measured against `defaultValues`, so a panel prefilled from an
  // existing version starts clean — exactly the meaning the screen wants.
  const { isDirty } = form.formState;
  useEffect(() => {
    onDirtyChange?.(isDirty);
  }, [isDirty, onDirtyChange]);
  // Unmounting takes the draft with it; the screen must not keep guarding one.
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

  /** Server-side variable complaints, one line per variable. */
  const serverIssues = ApiError.is(error)
    ? (error.issues ?? []).filter((issue) => issue.path === "body")
    : [];

  const errors = form.formState.errors;

  // Edge cases before the happy path: a hard refusal outranks the advisory
  // check, and the advisory check only speaks when nothing harder is wrong.
  const bodyStatus = errors.body
    ? ({ type: "error", message: errors.body.message } as const)
    : serverIssues.length > 0
      ? // Verbatim from the API, one sentence per offending variable: the server
        // has the final word on the whitelist and its wording is the answer.
        ({ type: "error", message: serverIssues.map((issue) => issue.message).join(" ") } as const)
      : report.missing.length > 0
        ? ({
            type: "warning",
            message: `Còn thiếu biến bắt buộc: ${report.missing.map((name) => `{{${name}}}`).join(", ")}.`,
          } as const)
        : report.unknown.length > 0
          ? ({
              type: "warning",
              message: `Biến không nằm trong danh sách cho phép: ${report.unknown
                .map((name) => `{{${name}}}`)
                .join(", ")}. Máy chủ sẽ từ chối lưu.`,
            } as const)
          : undefined;

  return (
    <form
      noValidate
      onSubmit={form.handleSubmit((values) => onSubmit(values))}
      aria-labelledby={headingId}
    >
      <Stack direction="vertical" gap={4}>
        <Stack direction="vertical" gap={1}>
          <Heading level={3} id={headingId}>
            Tạo phiên bản mới (v{nextVersion})
          </Heading>
          <Text type="supporting" color="secondary">
            Bản cũ không bị sửa hay xoá — mỗi lần lưu là một bản mới, để sau còn truy được caption
            nào sinh ra từ prompt nào.
          </Text>
        </Stack>

        <Controller
          control={form.control}
          name="name"
          render={({ field }) => (
            <TextInput
              ref={(node) => {
                field.ref(node);
                if (firstFieldRef) firstFieldRef.current = node;
              }}
              label="Tên phiên bản"
              value={field.value}
              onChange={field.onChange}
              onBlur={field.onBlur}
              htmlName={field.name}
              placeholder="Ví dụ: Giọng Tết 2027"
              hasAutoFocus
              width="100%"
              isDisabled={pending}
              disabledMessage={SAVING_MESSAGE}
              status={
                errors.name ? { type: "error", message: errors.name.message } : undefined
              }
              statusVariant="detached"
            />
          )}
        />

        <Controller
          control={form.control}
          name="systemPrompt"
          render={({ field }) => (
            <TextArea
              ref={field.ref}
              label="System prompt"
              description="Vai trò và luật chung cho AI. Không dùng biến ở đây."
              value={field.value}
              onChange={field.onChange}
              onBlur={field.onBlur}
              htmlName={field.name}
              rows={4}
              hasSpellCheck={false}
              width="100%"
              isDisabled={pending}
              disabledMessage={SAVING_MESSAGE}
              status={
                errors.systemPrompt
                  ? { type: "error", message: errors.systemPrompt.message }
                  : undefined
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
              ref={field.ref}
              label="Nội dung prompt"
              // One `description` rather than a paragraph underneath: Astryx
              // composes `aria-describedby` from its OWN slots (description,
              // status message, counter, disabled tooltip) and does not merge an
              // incoming one, so text put beside the field would never be
              // announced. Folding it into `description` is the only way in.
              description={`Dùng cú pháp {{tên_biến}}; danh sách biến hợp lệ ở khung “Biến được phép dùng” bên dưới. Biến đang dùng: ${
                report.variables.length > 0 ? report.variables.join(", ") : "(chưa có)"
              }.`}
              value={field.value}
              onChange={field.onChange}
              onBlur={field.onBlur}
              htmlName={field.name}
              rows={12}
              hasSpellCheck={false}
              width="100%"
              isDisabled={pending}
              disabledMessage={SAVING_MESSAGE}
              placeholder={
                "Viết caption cho sản phẩm {{product.name}}...\n\nRàng buộc: {{constraints}}"
              }
              status={bodyStatus}
              statusVariant="detached"
            />
          )}
        />

        <Controller
          control={form.control}
          name="changelog"
          render={({ field }) => (
            <TextArea
              ref={field.ref}
              label="Vì sao đổi (changelog)"
              value={field.value}
              onChange={field.onChange}
              onBlur={field.onBlur}
              htmlName={field.name}
              rows={2}
              width="100%"
              isDisabled={pending}
              disabledMessage={SAVING_MESSAGE}
              isRequired
              placeholder="Ví dụ: bỏ emoji ở câu mở, thêm nhắc size"
              status={
                errors.changelog ? { type: "error", message: errors.changelog.message } : undefined
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
              ref={field.ref}
              label="Kích hoạt ngay sau khi lưu"
              description="Bỏ tick để lưu thành bản nháp và kích hoạt sau. Kích hoạt đổi prompt cho MỌI caption sinh sau đó — caption đã sinh không bị ảnh hưởng."
              value={field.value}
              onChange={field.onChange}
              onBlur={field.onBlur}
              htmlName={field.name}
              isDisabled={pending}
              disabledMessage={SAVING_MESSAGE}
            />
          )}
        />

        <Collapsible
          defaultIsOpen={false}
          trigger={<Text type="label">Biến được phép dùng trong nội dung prompt</Text>}
        >
          <PromptVariablesHelp id={`${formId}-help`} />
        </Collapsible>

        {/* The whole refusal (code + sentence); the per-variable lines are above. */}
        {error ? <ApiErrorNotice error={error} /> : null}

        <Divider />

        <HStack gap={2} wrap="wrap" align="center">
          <Button
            type="submit"
            variant="primary"
            label={`Lưu phiên bản v${nextVersion}`}
            // Spinner for THIS form's own request only: a save blocked by an
            // activation is not loading, it is waiting, and a spinner on it
            // would claim a request nobody made here.
            isLoading={pending}
            isDisabled={pending || blockedReason !== null}
            // Without a tooltip Astryx uses NATIVE disabled, and a natively
            // disabled button that had focus drops the keyboard on <body> —
            // which is precisely what pressing this button does. Own save
            // first: it is the more specific answer when both are true.
            tooltip={pending ? SAVING_MESSAGE : (blockedReason ?? undefined)}
          />
          {onCancel ? (
            <Button
              type="button"
              variant="ghost"
              label="Huỷ tạo phiên bản mới"
              isDisabled={pending}
              tooltip={pending ? SAVING_MESSAGE : undefined}
              onClick={onCancel}
            >
              Huỷ
            </Button>
          ) : null}
        </HStack>
      </Stack>
    </form>
  );
}
