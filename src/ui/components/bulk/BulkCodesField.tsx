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

  const describedBy = [
    hintId,
    summaryId,
    error ? errorId : null,
    parsed.invalid.length > 0 ? issuesId : null,
  ]
    .filter(Boolean)
    .join(" ");

  const hasContent = parsed.codes.length > 0 || parsed.invalid.length > 0;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <label htmlFor={id} className="text-sm font-medium">
          Mã sản phẩm cần đăng
        </label>
        {hasContent ? (
          <span className="text-muted-foreground font-mono text-xs tabular-nums">
            {parsed.codes.length}/{MAX_BULK_CODES} mã
          </span>
        ) : null}
      </div>

      <Textarea
        id={id}
        {...registration}
        rows={7}
        disabled={disabled}
        spellCheck={false}
        autoComplete="off"
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        placeholder={"MGKVX6310\nMGKVX6311\nMGKVX6312"}
        className="font-mono text-sm leading-relaxed tracking-tight"
      />

      <p id={hintId} className="text-muted-foreground text-xs leading-normal">
        Mỗi dòng một mã, hoặc dán thẳng một cột từ Sheet. Nhiều mã trên cùng một dòng thì ngăn bằng
        dấu phẩy. Tối đa {MAX_BULK_CODES} mã mỗi lượt; mã trùng nhau chỉ chạy một lần.
      </p>

      {/* Accessible text summary for screen readers & quick scanning */}
      <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
        <p
          id={summaryId}
          role="status"
          aria-live="polite"
          className="text-muted-foreground text-xs tabular-nums"
        >
          Đã đọc được {parsed.codes.length} mã hợp lệ
          {parsed.duplicates > 0 ? ` · bỏ ${parsed.duplicates} mã trùng` : ""}
          {parsed.invalid.length > 0 ? ` · ${parsed.invalid.length} dòng chưa đúng` : ""}
          {parsed.overLimit.length > 0 ? ` · ${parsed.overLimit.length} mã vượt giới hạn` : ""}.
        </p>
      </div>

      {/* Parsed code chips preview for quick visual inspection */}
      {parsed.codes.length > 0 ? (
        <div className="space-y-1.5 pt-1">
          <div className="flex items-center justify-between text-[11px] text-muted-foreground">
            <span className="font-medium text-foreground">
              Mã đã nhận diện ({parsed.codes.length}):
            </span>
            <span>Hiển thị tối đa 12 mã đầu</span>
          </div>
          <div className="flex flex-wrap gap-1.5 max-h-24 overflow-y-auto rounded-lg border border-border/70 bg-muted/20 p-2">
            {parsed.codes.slice(0, 12).map((item, idx) => (
              <span
                key={`${item.code}-${idx}`}
                className="bg-card border-border/80 text-foreground font-mono text-[11px] font-medium px-2 py-0.5 rounded-md border shadow-xs inline-flex items-center gap-1"
              >
                <span className="text-muted-foreground text-[9px]">#{idx + 1}</span>
                {item.code}
              </span>
            ))}
            {parsed.codes.length > 12 ? (
              <span className="text-muted-foreground text-[11px] px-1.5 py-0.5 font-medium self-center">
                +{parsed.codes.length - 12} mã khác…
              </span>
            ) : null}
          </div>
        </div>
      ) : null}

      {error ? (
        <p id={errorId} role="alert" className="text-destructive text-sm font-medium">
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
          <ul className="mt-1.5 space-y-1">
            {parsed.invalid.map((issue, index) => (
              <li key={`${issue.line}-${index}`} className="text-xs">
                <span className="font-medium tabular-nums">Dòng {issue.line}:</span>{" "}
                <span className="font-mono break-all">{issue.raw}</span> — {issue.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {parsed.overLimit.length > 0 ? (
        <p role="alert" className="text-destructive text-xs font-medium">
          Vượt giới hạn {MAX_BULK_CODES} mã:{" "}
          <span className="font-mono">
            {parsed.overLimit.map((item) => item.code).join(", ")}
          </span>
          . Hãy bỏ bớt rồi chạy lượt sau.
        </p>
      ) : null}
    </div>
  );
}
