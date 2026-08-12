"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useId, useMemo } from "react";
import { useForm, useWatch } from "react-hook-form";

import { ApiErrorNotice } from "@/ui/components/feedback/ApiErrorNotice";
import { PromptVariablesHelp } from "@/ui/components/prompts/PromptVariablesHelp";
import { Button } from "@/ui/components/ui/button";
import { Input } from "@/ui/components/ui/input";
import { Textarea } from "@/ui/components/ui/textarea";
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
 * Variable errors are shown INLINE under the body, naming the variables:
 *  - locally, as a warning, while typing (advisory);
 *  - from the server, as the real refusal — the API returns one `issues` entry
 *    per offending variable, and those win.
 */
export function PromptVersionForm({
  tenantId,
  nextVersion,
  defaultValues,
  pending,
  error,
  warnings,
  onSubmit,
  onCancel,
}: {
  tenantId: string;
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
  const nameId = useId();
  const systemId = useId();
  const bodyId = useId();
  const changelogId = useId();
  const activateId = useId();

  const form = useForm<PromptVersionFormValues>({
    resolver: zodResolver(PromptVersionFormSchema),
    mode: "onSubmit",
    reValidateMode: "onChange",
    defaultValues: {
      tenantId,
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

  return (
    <form
      noValidate
      className="space-y-5"
      onSubmit={form.handleSubmit((values) => onSubmit(values))}
      aria-labelledby={`${nameId}-form-heading`}
    >
      <div className="space-y-1">
        <h3 id={`${nameId}-form-heading`} className="text-base font-semibold">
          Tạo phiên bản mới (v{nextVersion})
        </h3>
        <p className="text-muted-foreground text-sm">
          Phiên bản cũ không bị sửa hay xoá — mỗi lần lưu là một bản mới, để sau này còn truy được
          caption nào sinh ra từ prompt nào.
        </p>
      </div>

      <div className="space-y-1.5">
        <label htmlFor={nameId} className="text-sm font-medium">
          Tên phiên bản
        </label>
        <Input
          id={nameId}
          {...form.register("name")}
          autoComplete="off"
          aria-invalid={errors.name ? true : undefined}
          aria-describedby={errors.name ? `${nameId}-error` : undefined}
          placeholder="Ví dụ: Giọng Tết 2027"
        />
        {errors.name ? (
          <p id={`${nameId}-error`} role="alert" className="text-destructive text-sm">
            {errors.name.message}
          </p>
        ) : null}
      </div>

      <div className="space-y-1.5">
        <label htmlFor={systemId} className="text-sm font-medium">
          System prompt
        </label>
        <Textarea
          id={systemId}
          {...form.register("systemPrompt")}
          rows={4}
          spellCheck={false}
          aria-invalid={errors.systemPrompt ? true : undefined}
          aria-describedby={
            errors.systemPrompt ? `${systemId}-error ${systemId}-hint` : `${systemId}-hint`
          }
        />
        <p id={`${systemId}-hint`} className="text-muted-foreground text-xs">
          Vai trò và luật chung cho AI. Không dùng biến ở đây.
        </p>
        {errors.systemPrompt ? (
          <p id={`${systemId}-error`} role="alert" className="text-destructive text-sm">
            {errors.systemPrompt.message}
          </p>
        ) : null}
      </div>

      <div className="space-y-1.5">
        <label htmlFor={bodyId} className="text-sm font-medium">
          Nội dung prompt
        </label>
        <Textarea
          id={bodyId}
          {...form.register("body")}
          rows={12}
          spellCheck={false}
          className="font-mono text-sm"
          aria-invalid={errors.body || serverIssues.length > 0 ? true : undefined}
          aria-describedby={`${bodyId}-hint ${bodyId}-vars`}
          placeholder={"Viết caption cho sản phẩm {{product.name}}...\n\nRàng buộc: {{constraints}}"}
        />
        <p id={`${bodyId}-hint`} className="text-muted-foreground text-xs">
          Dùng cú pháp <code className="font-mono">{"{{tên_biến}}"}</code>. Danh sách biến hợp lệ ở
          khung bên dưới.
        </p>

        <p id={`${bodyId}-vars`} className="text-muted-foreground text-xs">
          Biến đang dùng: {report.variables.length > 0 ? report.variables.join(", ") : "(chưa có)"}.
        </p>

        {errors.body ? (
          <p role="alert" className="text-destructive text-sm">
            {errors.body.message}
          </p>
        ) : null}

        {/* Advisory, while typing — the server has the final word. */}
        {serverIssues.length === 0 && report.missing.length > 0 ? (
          <p className="text-warning-foreground text-sm">
            Còn thiếu biến bắt buộc: {report.missing.map((name) => `{{${name}}}`).join(", ")}.
          </p>
        ) : null}
        {serverIssues.length === 0 && report.unknown.length > 0 ? (
          <p className="text-warning-foreground text-sm">
            Biến không nằm trong danh sách cho phép:{" "}
            {report.unknown.map((name) => `{{${name}}}`).join(", ")}. Máy chủ sẽ từ chối lưu.
          </p>
        ) : null}

        {serverIssues.length > 0 ? (
          <ul role="alert" className="text-destructive space-y-1 text-sm">
            {serverIssues.map((issue, index) => (
              <li key={`${issue.message}-${index}`}>{issue.message}</li>
            ))}
          </ul>
        ) : null}
      </div>

      <div className="space-y-1.5">
        <label htmlFor={changelogId} className="text-sm font-medium">
          Vì sao đổi (changelog)
        </label>
        <Textarea
          id={changelogId}
          {...form.register("changelog")}
          rows={2}
          aria-invalid={errors.changelog ? true : undefined}
          aria-describedby={errors.changelog ? `${changelogId}-error` : undefined}
          placeholder="Ví dụ: bỏ emoji ở câu mở, thêm nhắc size"
        />
        {errors.changelog ? (
          <p id={`${changelogId}-error`} role="alert" className="text-destructive text-sm">
            {errors.changelog.message}
          </p>
        ) : null}
      </div>

      <label htmlFor={activateId} className="flex items-start gap-2 text-sm">
        <input
          id={activateId}
          type="checkbox"
          className="accent-primary mt-0.5 size-4"
          {...form.register("activate")}
        />
        <span>
          Kích hoạt ngay sau khi lưu
          <span className="text-muted-foreground block text-xs">
            Bỏ tick để lưu thành bản nháp và kích hoạt sau. Kích hoạt đổi prompt cho MỌI caption sinh
            sau đó — caption đã sinh không bị ảnh hưởng.
          </span>
        </span>
      </label>

      <PromptVariablesHelp id={`${bodyId}-help`} />

      {warnings && warnings.length > 0 ? (
        <div
          role="status"
          className="border-warning/40 bg-warning/10 text-warning-foreground rounded-lg border p-3 text-sm"
        >
          <p className="font-medium">Đã lưu, kèm lưu ý:</p>
          <ul className="mt-1 list-disc space-y-1 pl-5">
            {warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* The whole refusal (code + sentence); the per-variable lines are above. */}
      {error ? <ApiErrorNotice error={error} /> : null}

      <div className="flex flex-wrap gap-2 border-t pt-4">
        <Button type="submit" disabled={pending}>
          {pending ? "Đang lưu…" : `Lưu phiên bản v${nextVersion}`}
        </Button>
        {onCancel ? (
          <Button type="button" variant="ghost" onClick={onCancel} disabled={pending}>
            Huỷ
          </Button>
        ) : null}
      </div>
    </form>
  );
}
