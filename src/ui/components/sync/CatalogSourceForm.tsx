"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect, useId, useRef, useState } from "react";
import { useForm } from "react-hook-form";

import { ApiErrorNotice } from "@/ui/components/feedback/ApiErrorNotice";
import { Button } from "@/ui/components/ui/button";
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
    update.mutate(
      {
        ...values,
        /*
         * This form points the tenant at a GOOGLE TAB, so it says so — and the
         * saying is what makes the switch real.
         *
         * Without it, a tenant reading an uploaded CSV could fill in a
         * spreadsheet link here, press Đổi nguồn, get a 200 and a reset form,
         * and still be reading the old file: the usecase falls back to the
         * STORED kind when nothing is sent, so the source never moved. Silent
         * success on a write that did nothing is worse than a refusal, because
         * the operator walks away believing it (business rule 5).
         *
         * It also tells the client-side guard that the three coordinates are
         * required for THIS save, whatever the tenant was reading before.
         */
        textConfig: { kind: "google_sheet" as const },
      },
      {
        onSuccess: () => {
          form.reset(values);
          onSaved();
        },
      },
    );
  }

  return (
    <div className="space-y-4">
      <form noValidate onSubmit={form.handleSubmit(handleValid)} className="space-y-4">
        <Field
          id={`${fieldId}-drive`}
          label="Thư mục ảnh trên Google Drive"
          hint="Dán nguyên link từ trình duyệt cũng được, hoặc chỉ ID thư mục."
          error={form.formState.errors.driveFolder?.message}
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
        </Field>

        <Field
          id={`${fieldId}-sheet`}
          label="Bảng sản phẩm trên Google Sheet"
          hint="Dán nguyên link bảng cũng được, hoặc chỉ ID bảng."
          error={form.formState.errors.spreadsheet?.message}
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
        </Field>

        <Field
          id={`${fieldId}-tab`}
          label="Tên tab chứa bảng sản phẩm"
          hint="Đúng từng ký tự như trên Sheet, ví dụ: Mẫu 2026."
          error={form.formState.errors.sheetName?.message}
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
        </Field>

        {pending === null ? (
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={update.isPending}>
              {update.isPending ? "Đang lưu…" : "Lưu nguồn mới"}
            </Button>
            {onCancel ? (
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  form.reset();
                  update.reset();
                  onCancel();
                }}
                disabled={update.isPending}
              >
                Huỷ
              </Button>
            ) : null}
          </div>
        ) : null}
      </form>

      {pending ? (
        <div
          role="group"
          aria-label="Xác nhận đổi nguồn dữ liệu"
          onKeyDown={(event) => {
            if (event.key === "Escape") setPending(null);
          }}
          className="border-warning/40 bg-warning/5 space-y-3 rounded-xl border p-4"
        >
          <p className="text-sm font-medium">Đổi nguồn dữ liệu của đơn vị này?</p>
          {/*
            A tenant switching AWAY from an uploaded file is making a bigger
            change than one editing a folder id, and only this screen knows it is
            about to happen. Naming the file makes the consequence concrete:
            after this, nothing reads that file again.
          */}
          {current?.textSource?.kind === "file" ? (
            <p className="text-sm">
              Đơn vị này đang đọc file{" "}
              <span className="font-medium">“{current.textSource.fileName}”</span>. Lưu xong hệ
              thống chuyển sang đọc bảng Google Sheet ở trên và{" "}
              <span className="font-medium">không đọc file đó nữa</span>.
            </p>
          ) : null}
          <p className="text-muted-foreground text-sm">
            Đổi nguồn xong cần bấm <span className="text-foreground font-medium">Chạy đồng bộ</span>{" "}
            lại. Lần đồng bộ kế tiếp sẽ xoá sản phẩm/ảnh không còn thuộc nguồn mới.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button ref={confirmRef} type="button" onClick={save}>
              Đổi nguồn
            </Button>
            <Button type="button" variant="outline" onClick={() => setPending(null)}>
              Xem lại
            </Button>
          </div>
        </div>
      ) : null}

      <p className="sr-only" role="status" aria-live="polite">
        {update.isPending ? "Đang lưu nguồn dữ liệu" : ""}
      </p>

      {update.isError ? <ApiErrorNotice error={update.error} /> : null}
    </div>
  );
}

/** Field wrapper: label + hint + error wired together for assistive tech. */
function Field({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string;
  label: string;
  hint: string;
  error?: string;
  children: (props: {
    id: string;
    "aria-invalid": boolean;
    "aria-describedby": string;
  }) => React.ReactNode;
}) {
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;

  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      {children({
        id,
        "aria-invalid": Boolean(error),
        "aria-describedby": error ? `${errorId} ${hintId}` : hintId,
      })}
      <p id={hintId} className="text-muted-foreground text-xs">
        {hint}
      </p>
      {error ? (
        <p id={errorId} role="alert" className="text-destructive text-xs">
          {error}
        </p>
      ) : null}
    </div>
  );
}
