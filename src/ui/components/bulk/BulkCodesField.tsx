"use client";

import type { UseFormRegisterReturn } from "react-hook-form";

import { Textarea } from "@/ui/components/ui/textarea";
import { MAX_BULK_CODES, type ParsedBulkCodes } from "@/ui/schemas/bulk.schema";

/**
 * The "dán mã vào đây" field (E10.5).
 *
 * It reports what the parser understood WHILE the operator types: how many
 * codes, which lines are not codes, how many repeats were dropped. A paste from
 * the Sheet that silently loses three rows is the failure mode this block
 * exists to prevent (core-bulk-actions: never silently drop a selection).
 *
 * Presentational: parsing happens in `ui/schemas/bulk.schema.ts`, the value is
 * owned by the form in the parent.
 */
export function BulkCodesField({
  id,
  registration,
  parsed,
  error,
  disabled,
}: {
  id: string;
  registration: UseFormRegisterReturn;
  parsed: ParsedBulkCodes;
  /** Message from the zod schema (empty, over limit, invalid lines). */
  error?: string;
  disabled?: boolean;
}) {
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const summaryId = `${id}-summary`;
  const issuesId = `${id}-issues`;

  const describedBy = [hintId, summaryId, error ? errorId : null, parsed.invalid.length > 0 ? issuesId : null]
    .filter(Boolean)
    .join(" ");

  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="text-sm font-medium">
        Mã sản phẩm cần đăng
      </label>
      <Textarea
        id={id}
        {...registration}
        rows={8}
        disabled={disabled}
        spellCheck={false}
        autoComplete="off"
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        placeholder={"MGKVX6310\nMGKVX6311\nMGKVX6312"}
        className="font-mono text-sm"
      />

      <p id={hintId} className="text-muted-foreground text-xs">
        Mỗi dòng một mã, hoặc dán thẳng một cột từ Sheet. Nhiều mã trên cùng một dòng thì ngăn bằng
        dấu phẩy. Tối đa {MAX_BULK_CODES} mã mỗi lượt; mã trùng nhau chỉ chạy một lần.
      </p>

      {/* Polite: the count changes on every keystroke, it must not interrupt. */}
      <p id={summaryId} role="status" aria-live="polite" className="text-muted-foreground text-xs">
        Đã đọc được {parsed.codes.length} mã hợp lệ
        {parsed.duplicates > 0 ? ` · bỏ ${parsed.duplicates} mã trùng` : ""}
        {parsed.invalid.length > 0 ? ` · ${parsed.invalid.length} dòng chưa đúng` : ""}
        {parsed.overLimit.length > 0 ? ` · ${parsed.overLimit.length} mã vượt giới hạn` : ""}.
      </p>

      {error ? (
        <p id={errorId} role="alert" className="text-destructive text-sm">
          {error}
        </p>
      ) : null}

      {parsed.invalid.length > 0 ? (
        <div
          id={issuesId}
          className="border-warning/40 bg-warning/10 max-h-48 overflow-auto rounded-lg border p-3"
        >
          <p className="text-warning-foreground text-xs font-medium">
            Các dòng sau không phải mã sản phẩm:
          </p>
          <ul className="mt-1 space-y-1">
            {parsed.invalid.map((issue, index) => (
              <li key={`${issue.line}-${index}`} className="text-xs">
                <span className="font-medium">Dòng {issue.line}:</span>{" "}
                <span className="font-mono break-all">{issue.raw}</span> — {issue.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {parsed.overLimit.length > 0 ? (
        <p role="alert" className="text-destructive text-xs">
          Vượt giới hạn {MAX_BULK_CODES} mã: {parsed.overLimit.map((item) => item.code).join(", ")}.
          Hãy bỏ bớt rồi chạy lượt sau.
        </p>
      ) : null}
    </div>
  );
}
