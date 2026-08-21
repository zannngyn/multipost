"use client";

import { useId, useState } from "react";
import type { UseFormRegisterReturn } from "react-hook-form";

import { cn } from "@/shared/utils";
import {
  nextHighlight,
  toProductSuggestion,
  type ProductSuggestion,
} from "@/ui/components/compose/product-suggestions";
import { Button } from "@/ui/components/ui/button";
import { Input } from "@/ui/components/ui/input";
import { useDebouncedValue } from "@/ui/hooks/useDebouncedValue";
import { useProductSuggestions } from "@/ui/hooks/useProductSuggestions";
import { presentApiError } from "@/ui/components/feedback/present-api-error";

/**
 * The one field that starts a post: type a code, or pick it out of the catalog.
 *
 * `<input>` + suggestion list, NOT a closed `<select>`-style combobox
 * (core-form-inputs §cây quyết định, row "vừa chọn gợi ý vừa nhập tự do"): a
 * code that was added to the Sheet since the last sync is not in the list yet,
 * and the operator must still be able to type it and let the server answer.
 *
 * [L6-New] No combobox primitive exists in this repo and Radix ships none;
 * adding a combobox library needs approval, so the ARIA contract is implemented
 * here by hand and kept to the checklist in core-form-inputs:
 *   - `role="combobox"` + `aria-expanded` + `aria-controls` + `aria-autocomplete`
 *     on the input, `role="listbox"` on the list, `role="option"` on the rows;
 *   - focus NEVER leaves the input — the highlighted row is named by
 *     `aria-activedescendant`, which is why the rows are `<li>` and not buttons;
 *   - ↓ ↑ wrap, Enter picks, Escape closes and KEEPS what was typed, Tab closes;
 *   - the number of results is announced politely.
 *
 * Business rule 1 made visible: a code the server marked un-composable — hết
 * hàng above all — is refused HERE, before a caption is ever written for it.
 * The server still runs the stock gate twice; this only saves the operator the
 * detour.
 */
export function ProductPicker({
  id,
  register,
  value,
  onSelectCode,
  onSubmit,
  disabled = false,
  invalid = false,
  describedBy,
  placeholder = "Nhập mã sản phẩm, ví dụ MGKVX6310",
  inputClassName,
}: {
  id: string;
  /** The RHF registration of `productCode` — keeps validation and `setFocus`. */
  register: UseFormRegisterReturn;
  value: string;
  /** Writes the picked code into the form. */
  onSelectCode: (code: string) => void;
  /** Runs the lookup — the same action as the form's submit button. */
  onSubmit: () => void;
  disabled?: boolean;
  invalid?: boolean;
  describedBy?: string;
  placeholder?: string;
  /**
   * Skin only — appended last, so the caller can restate size and radius. The
   * ARIA contract above is NOT a caller's business and cannot be overridden.
   */
  inputClassName?: string;
}) {
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  /** Set when the operator picked a row the server will not compose. */
  const [refused, setRefused] = useState<string | null>(null);

  // Debounce the INPUT, never the list rendering: the dropdown must not blink
  // once per keystroke (core-feedback-states §ngưỡng thời gian).
  const query = useDebouncedValue(value, 300);
  const suggestions = useProductSuggestions(query, open);

  const items: ProductSuggestion[] = (suggestions.data?.items ?? []).map(toProductSuggestion);
  const total = suggestions.data?.totals.total ?? null;
  const isLoading = suggestions.isPending || (suggestions.isFetching && !suggestions.data);

  function close() {
    setOpen(false);
    setHighlight(-1);
  }

  function pick(item: ProductSuggestion) {
    if (item.disabled) {
      // Not a silent no-op: the row explains itself, and the alert below the
      // field repeats it where a screen reader will pick it up.
      setRefused(item.blockedMessage);
      return;
    }
    setRefused(null);
    onSelectCode(item.code);
    close();
    onSubmit();
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      if (!open) return;
      // Closes, keeps what was typed. Stopped so it does not also close a
      // surrounding dialog.
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }

    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
      setHighlight((current) => nextHighlight(current, event.key === "ArrowDown" ? 1 : -1, items.length));
      return;
    }

    if (event.key === "Home" || event.key === "End") {
      if (!open || items.length === 0) return;
      event.preventDefault();
      setHighlight(event.key === "Home" ? 0 : items.length - 1);
      return;
    }

    if (event.key === "Enter" && open && highlight >= 0 && items[highlight]) {
      // Consumed: the form's own submit must not fire on the same keystroke.
      event.preventDefault();
      pick(items[highlight]);
      return;
    }

    if (event.key === "Tab") close();
  }

  const activeId = open && highlight >= 0 ? `${listId}-option-${highlight}` : undefined;

  return (
    <div className="flex flex-col gap-1.5">
      <div className="relative">
        {/* Deliberately uncontrolled: `register` owns the element through its
            ref, and `value` below is the WATCHED copy used to drive the query.
            Passing it back as `value` would fight RHF for the same input. */}
        <Input
          {...register}
          id={id}
          onChange={(event) => {
            void register.onChange(event);
            setOpen(true);
            setHighlight(-1);
            setRefused(null);
          }}
          onFocus={() => setOpen(true)}
          onBlur={(event) => {
            void register.onBlur(event);
            close();
          }}
          onKeyDown={handleKeyDown}
          disabled={disabled}
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={activeId}
          aria-invalid={invalid}
          aria-describedby={describedBy}
          placeholder={placeholder}
          autoComplete="off"
          spellCheck={false}
          className={cn("h-12 font-mono text-base uppercase", inputClassName)}
        />

        {open ? (
          <div className="border-border bg-popover absolute inset-x-0 top-[calc(100%+0.375rem)] z-20 flex max-h-90 flex-col overflow-hidden rounded-xl border shadow-lg">
            <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
              {isLoading ? (
                <ul aria-hidden="true" className="flex flex-col gap-1 motion-safe:animate-pulse">
                  {[0, 1, 2].map((row) => (
                    <li key={row} className="flex items-center gap-3 px-2.5 py-2">
                      <span className="bg-muted size-9 shrink-0 rounded-lg" />
                      <span className="flex min-w-0 flex-1 flex-col gap-1.5">
                        <span className="bg-muted h-3 w-24 rounded" />
                        <span className="bg-muted h-3 w-40 rounded" />
                      </span>
                    </li>
                  ))}
                </ul>
              ) : suggestions.isError ? (
                <div className="flex flex-col items-start gap-2 px-2.5 py-3">
                  <p className="text-sm font-medium">{presentApiError(suggestions.error).title}</p>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    // The pointer must not leave the input, or the list closes
                    // before the click lands.
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => void suggestions.refetch()}
                  >
                    Thử lại
                  </Button>
                  <p className="text-muted-foreground text-xs leading-relaxed">
                    Không tra được danh mục, nhưng bạn vẫn gõ thẳng mã rồi bấm “Tra dữ liệu sản phẩm”
                    được.
                  </p>
                </div>
              ) : items.length === 0 ? (
                <div className="px-2.5 py-3">
                  <p className="text-sm font-medium">
                    {query.trim().length === 0
                      ? "Danh mục đang trống"
                      : `Không có mã nào khớp “${query.trim()}”`}
                  </p>
                  <p className="text-muted-foreground pt-1 text-xs leading-relaxed">
                    {query.trim().length === 0
                      ? "Chạy đồng bộ Sheet/Drive ở màn Sản phẩm, hoặc gõ thẳng mã nếu bạn biết chắc."
                      : "Mã vừa thêm vào Sheet chưa được đồng bộ vẫn gõ thẳng được — hệ thống sẽ tra lại khi bạn bấm nút."}
                  </p>
                </div>
              ) : (
                <ul id={listId} role="listbox" aria-label="Gợi ý mã sản phẩm" className="flex flex-col">
                  {items.map((item, index) => (
                    <li
                      key={item.code}
                      id={`${listId}-option-${index}`}
                      role="option"
                      aria-selected={index === highlight}
                      aria-disabled={item.disabled}
                      onMouseDown={(event) => event.preventDefault()}
                      onMouseEnter={() => setHighlight(index)}
                      onClick={() => pick(item)}
                      className={cn(
                        "flex items-start gap-3 rounded-lg px-2.5 py-2",
                        item.disabled ? "cursor-not-allowed" : "cursor-pointer",
                        index === highlight && "bg-muted",
                      )}
                    >
                      <span
                        aria-hidden="true"
                        className={cn(
                          "mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg font-mono text-xs",
                          // `text-muted-foreground`, NOT `text-foreground-subtle`:
                          // subtle only clears 4.5:1 on the page and card inks —
                          // on `--muted` it measures 4.36:1 (light) / 4.07:1
                          // (dark), i.e. under the floor for text this small.
                          // Muted-foreground is the tone the swatch scale keeps
                          // for exactly this pairing.
                          item.disabled
                            ? "bg-muted text-muted-foreground"
                            : "bg-accent/40 text-accent-foreground",
                        )}
                      >
                        {item.code.slice(0, 2)}
                      </span>

                      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span className="font-mono text-xs tracking-wide">{item.code}</span>
                        <span
                          className={cn(
                            "truncate text-sm",
                            item.disabled ? "text-muted-foreground" : "font-medium",
                          )}
                        >
                          {item.name}
                        </span>
                        {item.blockedMessage ? (
                          <span className="text-warning-foreground text-xs leading-relaxed">
                            {item.blockedMessage}
                          </span>
                        ) : null}
                      </span>

                      <span className="text-muted-foreground shrink-0 pt-0.5 text-xs whitespace-nowrap">
                        {item.meta}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {total !== null ? (
              <p className="border-border text-muted-foreground border-t px-3 py-2 text-xs">
                Đang lọc trong {total} sản phẩm đã đồng bộ. Mã chưa đồng bộ vẫn gõ thẳng được.
              </p>
            ) : null}
          </div>
        ) : null}
      </div>

      {/* Result count, announced without stealing focus (core-form-inputs). */}
      <p className="sr-only" role="status" aria-live="polite">
        {open && !isLoading && !suggestions.isError ? `${items.length} kết quả` : ""}
      </p>

      {refused ? (
        <p role="alert" className="text-warning-foreground text-xs leading-relaxed">
          {refused} Hãy chọn mã khác, hoặc cập nhật tồn trên Sheet rồi đồng bộ lại.
        </p>
      ) : null}
    </div>
  );
}
