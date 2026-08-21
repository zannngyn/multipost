"use client";

import { Banner, Button, Field, HStack, Stack, VisuallyHidden } from "@astryxdesign/core";
import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect, useId, useRef, useState } from "react";
import { useForm } from "react-hook-form";

import { ApiErrorNotice } from "@/ui/components/feedback/ApiErrorNotice";
import { Input } from "@/ui/components/ui/input";
import { useUpdateCatalogSource } from "@/ui/hooks/useCatalogProducts";
import {
  CatalogSourceFormSchema,
  isCatalogSourceField,
  type CatalogSource,
  type CatalogSourceFormValues,
} from "@/ui/schemas/catalog.schema";
import { ApiError } from "@/ui/services/api-error";

/**
 * "Đổi nguồn" — point the tenant at another Drive folder / Sheet tab.
 *
 * Two rules shape this form:
 *  1. It accepts a PASTED BROWSER LINK as readily as a bare id, because that is
 *     what an operator actually has in their clipboard. The parsing is the
 *     server's (one parser, one truth); this side only checks "not empty".
 *  2. Saving is destructive in a delayed way: the source changes now, and the
 *     NEXT sync deletes every product/photo that no longer belongs to it. That
 *     is why there is a confirmation step spelling it out — the operator must
 *     be told before, not discover it after a sync (business rule 5).
 *
 * The controls stay the repo `Input`: they are bound with react-hook-form
 * `register()`, and Astryx `TextInput` is a controlled `value`/`onChange(value)`
 * component, so swapping it would rewrite the form wiring rather than the
 * presentation. Astryx `Field` supplies the label / description / status shell
 * around them, which is exactly what `Field` is for — one field shell for the
 * whole app instead of a private one per form.
 *
 * Field errors from the server (`issues[].path`) are placed back on the right
 * input, so "link sai host" lands under the Drive field, not in a red box.
 */
export function CatalogSourceForm({
  current,
  onSaved,
  onCancel,
}: {
  /** Absent when the tenant has no source yet — the form starts empty. */
  current?: CatalogSource;
  /** Called after a successful save (the card closes the form and nudges sync). */
  onSaved: () => void;
  /** Absent = the form is the only content (tenant not configured yet). */
  onCancel?: () => void;
}) {
  const fieldId = useId();
  const update = useUpdateCatalogSource();
  const confirmRef = useRef<HTMLButtonElement>(null);
  const [pending, setPending] = useState<CatalogSourceFormValues | null>(null);

  const form = useForm<CatalogSourceFormValues>({
    resolver: zodResolver(CatalogSourceFormSchema),
    mode: "onSubmit",
    defaultValues: {
      driveFolder: current?.driveFolderId ?? "",
      spreadsheet: current?.spreadsheetId ?? "",
      sheetName: current?.sheetName ?? "",
    },
  });

  // Focus lands on the decision, not on the panel behind it.
  useEffect(() => {
    if (pending) confirmRef.current?.focus();
  }, [pending]);

  /**
   * Server-side validation belongs on the fields it names. Anything the server
   * reports on a field the form does not own stays in <ApiErrorNotice> — it is
   * never dropped (CLAUDE.md rule 5: no error disappears).
   */
  useEffect(() => {
    if (!update.isError || !ApiError.is(update.error)) return;
    for (const issue of update.error.issues ?? []) {
      if (isCatalogSourceField(issue.path)) {
        form.setError(issue.path, { type: "server", message: issue.message });
      }
    }
  }, [update.isError, update.error, form]);

  function handleValid(values: CatalogSourceFormValues) {
    update.reset();
    setPending(values);
  }

  function save() {
    if (!pending) return;
    const values = pending;
    setPending(null);
    update.mutate(values, {
      onSuccess: () => {
        form.reset(values);
        onSaved();
      },
    });
  }

  return (
    <Stack direction="vertical" gap={4}>
      <form noValidate onSubmit={form.handleSubmit(handleValid)}>
        <Stack direction="vertical" gap={4}>
          <SourceField
            id={`${fieldId}-drive`}
            label="Thư mục ảnh trên Google Drive"
            hint="Dán nguyên link từ trình duyệt cũng được, hoặc chỉ ID thư mục."
            error={form.formState.errors.driveFolder?.message}
            isDisabled={update.isPending}
          >
            {(props) => (
              <Input
                {...form.register("driveFolder")}
                {...props}
                placeholder="https://drive.google.com/drive/folders/…"
                autoComplete="off"
                spellCheck={false}
                className="font-mono"
                disabled={update.isPending}
              />
            )}
          </SourceField>

          <SourceField
            id={`${fieldId}-sheet`}
            label="Bảng sản phẩm trên Google Sheet"
            hint="Dán nguyên link bảng cũng được, hoặc chỉ ID bảng."
            error={form.formState.errors.spreadsheet?.message}
            isDisabled={update.isPending}
          >
            {(props) => (
              <Input
                {...form.register("spreadsheet")}
                {...props}
                placeholder="https://docs.google.com/spreadsheets/d/…"
                autoComplete="off"
                spellCheck={false}
                className="font-mono"
                disabled={update.isPending}
              />
            )}
          </SourceField>

          <SourceField
            id={`${fieldId}-tab`}
            label="Tên tab chứa bảng sản phẩm"
            hint="Đúng từng ký tự như trên Sheet, ví dụ: Mẫu 2026."
            error={form.formState.errors.sheetName?.message}
            isDisabled={update.isPending}
          >
            {(props) => (
              <Input
                {...form.register("sheetName")}
                {...props}
                placeholder="Mẫu 2026"
                autoComplete="off"
                disabled={update.isPending}
              />
            )}
          </SourceField>

          {pending === null ? (
            <HStack gap={2} align="center" wrap="wrap">
              <Button
                type="submit"
                variant="primary"
                label={update.isPending ? "Đang lưu…" : "Lưu nguồn mới"}
                isLoading={update.isPending}
                isDisabled={update.isPending}
              />
              {onCancel ? (
                <Button
                  variant="ghost"
                  label="Huỷ"
                  isDisabled={update.isPending}
                  onClick={() => {
                    form.reset();
                    update.reset();
                    onCancel();
                  }}
                />
              ) : null}
            </HStack>
          ) : null}
        </Stack>
      </form>

      {pending ? (
        <Stack
          direction="vertical"
          role="group"
          aria-label="Xác nhận đổi nguồn dữ liệu"
          onKeyDown={(event) => {
            if (event.key === "Escape") setPending(null);
          }}
        >
          <Banner
            status="warning"
            title="Đổi nguồn dữ liệu của đơn vị này?"
            description="Đổi nguồn xong cần bấm “Chạy đồng bộ” lại. Lần đồng bộ kế tiếp sẽ xoá sản phẩm/ảnh không còn thuộc nguồn mới."
            endContent={
              <HStack gap={2} align="center" wrap="wrap">
                <Button ref={confirmRef} variant="primary" label="Đổi nguồn" onClick={save} />
                <Button variant="secondary" label="Xem lại" onClick={() => setPending(null)} />
              </HStack>
            }
          />
        </Stack>
      ) : null}

      <VisuallyHidden as="div" role="status" aria-live="polite">
        {update.isPending ? "Đang lưu nguồn dữ liệu" : ""}
      </VisuallyHidden>

      {update.isError ? <ApiErrorNotice error={update.error} /> : null}
    </Stack>
  );
}

/**
 * Astryx `Field` around the repo input, with the ids wired for assistive tech.
 * The render-prop shape is kept from the previous version so the `register()`
 * spread still lands on the control itself.
 */
function SourceField({
  id,
  label,
  hint,
  error,
  isDisabled,
  children,
}: {
  id: string;
  label: string;
  hint: string;
  error?: string;
  isDisabled?: boolean;
  children: (props: {
    id: string;
    "aria-invalid": boolean;
    "aria-describedby": string;
  }) => React.ReactNode;
}) {
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;

  return (
    <Field
      label={label}
      inputID={id}
      description={hint}
      descriptionID={hintId}
      isDisabled={isDisabled}
      // Detached: the control is a plain bordered input, so an attached message
      // would sit on top of its own border.
      statusVariant="detached"
      status={error ? { type: "error", message: error, messageID: errorId } : undefined}
    >
      {children({
        id,
        "aria-invalid": Boolean(error),
        "aria-describedby": error ? `${errorId} ${hintId}` : hintId,
      })}
    </Field>
  );
}
