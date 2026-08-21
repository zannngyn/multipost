"use client";

import { Banner, Field, List, ListItem, Stack, Text } from "@astryxdesign/core";
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
 * The control stays the repo `Textarea`: it is bound with react-hook-form
 * `register()`, and Astryx `TextArea` is a controlled `value`/`onChange(value)`
 * component, so swapping it would rewrite the form wiring rather than the
 * presentation. `Field` supplies the label, description and status shell around
 * it, which is exactly what `Field` is for.
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
    <Stack direction="vertical" gap={2}>
      <Field
        label="Mã sản phẩm cần đăng"
        inputID={id}
        descriptionID={hintId}
        description={`Mỗi dòng một mã, hoặc dán thẳng một cột từ Sheet. Nhiều mã trên cùng một dòng thì ngăn bằng dấu phẩy. Tối đa ${MAX_BULK_CODES} mã mỗi lượt; mã trùng nhau chỉ chạy một lần.`}
        isDisabled={disabled}
        // Detached: the control is a plain bordered textarea, so an attached
        // message would sit on top of its own border.
        statusVariant="detached"
        status={error ? { type: "error", message: error, messageID: errorId } : undefined}
      >
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
          // Pasted codes are data, so they line up in a monospace column.
          className="font-mono"
        />
      </Field>

      {/* Polite: the count changes on every keystroke, it must not interrupt. */}
      <Text id={summaryId} type="supporting" role="status" aria-live="polite">
        Đã đọc được {parsed.codes.length} mã hợp lệ
        {parsed.duplicates > 0 ? ` · bỏ ${parsed.duplicates} mã trùng` : ""}
        {parsed.invalid.length > 0 ? ` · ${parsed.invalid.length} dòng chưa đúng` : ""}
        {parsed.overLimit.length > 0 ? ` · ${parsed.overLimit.length} mã vượt giới hạn` : ""}.
      </Text>

      {parsed.invalid.length > 0 ? (
        <Banner
          id={issuesId}
          status="warning"
          title={`${parsed.invalid.length} dòng không phải mã sản phẩm`}
          description="Những dòng này sẽ không được chạy. Sửa hoặc xoá chúng khỏi ô trên."
          // Open on arrival: an operator who just pasted needs to see WHICH
          // lines were dropped, not a closed drawer promising to say later.
          defaultIsExpanded
        >
          <List density="compact" hasDividers>
            {parsed.invalid.map((issue, index) => (
              <ListItem
                key={`${issue.line}-${index}`}
                label={`Dòng ${issue.line}`}
                description={
                  <Text type="supporting">
                    <Text type="code">{issue.raw}</Text> {issue.message}
                  </Text>
                }
              />
            ))}
          </List>
        </Banner>
      ) : null}

      {parsed.overLimit.length > 0 ? (
        <Banner
          role="alert"
          status="error"
          title={`Vượt giới hạn ${MAX_BULK_CODES} mã mỗi lượt`}
          description={`Sẽ không chạy: ${parsed.overLimit.map((item) => item.code).join(", ")}. Bỏ bớt rồi chạy lượt sau.`}
        />
      ) : null}
    </Stack>
  );
}
