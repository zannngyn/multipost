"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { UseFormRegisterReturn } from "react-hook-form";

import { cn } from "@/shared/utils";
import {
  nextHighlight,
  selectableSuggestions,
  suggestionEmptyState,
  suggestionFooterText,
  type ProductSuggestion,
} from "@/ui/components/compose/product-suggestions";
import { Button } from "@/ui/components/ui/button";
import { Input } from "@/ui/components/ui/input";
import { useDebouncedValue } from "@/ui/hooks/useDebouncedValue";
import { SUGGESTION_LIMIT, useProductSuggestions } from "@/ui/hooks/useProductSuggestions";
import { presentApiError } from "@/ui/components/feedback/present-api-error";

/**
 * The one field that starts a post: type a code, or pick it out of the catalog.
 *
 * `<input>` + suggestion list, NOT a closed `<select>`-style combobox
 * (core-form-inputs §cây quyết định, row "vừa chọn gợi ý vừa nhập tự do"): a
 * code added to the catalog since the last sync is not in the list yet,
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
 * Business rule 1 made visible: only codes the server marked composable are
 * OFFERED here. A blocked one is not listed-and-greyed, it is absent — a row
 * that exists only to be refused costs the operator a read and a click and
 * teaches nothing, while the reason (hết hàng, thiếu ảnh, dữ liệu lệch) belongs
 * on the product screen, which is the only place it can be fixed. The count of
 * what was left out is still printed under the list, so "ẩn" never reads as
 * "không tồn tại". Typing a blocked code by hand still works and still gets the
 * server's answer; the server runs the stock gate twice regardless.
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
  suppressSuggestions = false,
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
  /**
   * Another panel now owns the space under this field — today the typed-product
   * editor (onboarding phase 3). The suggestion list is FORCED SHUT while it is
   * true and will not reopen on focus.
   *
   * It exists because closing on blur alone was not enough. The list is
   * absolutely positioned over the card, so an open one covers the heading of
   * whatever opened beneath it — and overlap is a CSS fact no DOM test sees.
   * More to the point, the list would be lying: the editor is only ever open
   * because the code is NOT in the synced catalog, so "Không có mã nào khớp" is
   * the one sentence nobody needs repeated over the form that fixes it.
   * Suppressing also disables the query — no request for an answer already known.
   */
  suppressSuggestions?: boolean;
  placeholder?: string;
  /**
   * Skin only — appended last, so the caller can restate size and radius. The
   * ARIA contract above is NOT a caller's business and cannot be overridden.
   */
  inputClassName?: string;
}) {
  const listId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(-1);

  /**
   * The ONE answer to "is the list showing", derived rather than stored: a
   * second piece of state kept in sync by an effect is how "closed" and
   * "rendered" drift apart. Everything below reads this — the query, the markup
   * and every ARIA attribute — so the three cannot disagree.
   */
  const isOpen = open && !suppressSuggestions;

  // Debounce the INPUT, never the list rendering: the dropdown must not blink
  // once per keystroke (core-feedback-states §ngưỡng thời gian).
  const query = useDebouncedValue(value, 300);
  const suggestions = useProductSuggestions(query, isOpen);

  const items: readonly ProductSuggestion[] = selectableSuggestions(suggestions.data?.items ?? []);
  const totals = suggestions.data?.totals ?? null;
  /** Codes that matched the search but cannot be posted — counted, not listed. */
  const hiddenCount = totals?.blocked ?? 0;
  const isLoading = suggestions.isPending || (suggestions.isFetching && !suggestions.data);

  function close() {
    setOpen(false);
    setHighlight(-1);
  }

  /**
   * A pointer landing outside closes the list — the same rule Escape follows
   * (core-form-architecture: chạm ngoài và ESC dùng chung một hàm xử lý).
   *
   * Blur used to be the whole mechanism, and it is not enough: a press that does
   * not move focus never fires it, and the list then hangs over whatever the
   * press opened. `pointerdown` rather than `click`, so the list is gone before
   * the new panel paints; capture phase, so a handler that stops propagation
   * cannot swallow it. It never swallows the press itself — the control
   * underneath receives that very same interaction.
   */
  useEffect(() => {
    if (!isOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && rootRef.current?.contains(target)) return;
      setOpen(false);
      setHighlight(-1);
    };

    document.addEventListener("pointerdown", handlePointerDown, true);
    return () => document.removeEventListener("pointerdown", handlePointerDown, true);
  }, [isOpen]);

  function pick(item: ProductSuggestion) {
    onSelectCode(item.code);
    close();
    onSubmit();
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      if (!isOpen) return;
      // Closes, keeps what was typed. Stopped so it does not also close a
      // surrounding dialog.
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }

    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      // Suppressed means another panel owns the space below the field; ↓ must
      // not force a list back on top of it.
      if (suppressSuggestions) return;
      event.preventDefault();
      setOpen(true);
      setHighlight((current) => nextHighlight(current, event.key === "ArrowDown" ? 1 : -1, items.length));
      return;
    }

    if (event.key === "Home" || event.key === "End") {
      if (!isOpen || items.length === 0) return;
      event.preventDefault();
      setHighlight(event.key === "Home" ? 0 : items.length - 1);
      return;
    }

    if (event.key === "Enter" && isOpen && highlight >= 0 && items[highlight]) {
      // Consumed: the form's own submit must not fire on the same keystroke.
      event.preventDefault();
      pick(items[highlight]);
      return;
    }

    if (event.key === "Tab") close();
  }

  const activeId = isOpen && highlight >= 0 ? `${listId}-option-${highlight}` : undefined;

  return (
    <div ref={rootRef} className="flex flex-col gap-1.5">
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
          }}
          onFocus={() => {
            if (suppressSuggestions) return;
            setOpen(true);
          }}
          onBlur={(event) => {
            void register.onBlur(event);
            close();
          }}
          onKeyDown={handleKeyDown}
          disabled={disabled}
          role="combobox"
          aria-expanded={isOpen}
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

        {isOpen ? (
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
                    {suggestionEmptyState(query, hiddenCount).title}
                  </p>
                  <p className="text-muted-foreground pt-1 text-xs leading-relaxed">
                    {suggestionEmptyState(query, hiddenCount).hint}
                  </p>
                </div>
              ) : (
                <ul id={listId} role="listbox" aria-label="Gợi ý mã sản phẩm đăng được" className="flex flex-col">
                  {items.map((item, index) => (
                    <li
                      key={item.code}
                      id={`${listId}-option-${index}`}
                      role="option"
                      aria-selected={index === highlight}
                      onMouseDown={(event) => event.preventDefault()}
                      onMouseEnter={() => setHighlight(index)}
                      onClick={() => pick(item)}
                      className={cn(
                        "flex cursor-pointer items-start gap-3 rounded-lg px-2.5 py-2",
                        index === highlight && "bg-muted",
                      )}
                    >
                      {/* The CODE is the line that matters: it is what the
                          operator copies into the Sheet, says on the phone and
                          types next time, so it is read first and at full size.
                          The name is what confirms the pick, and sits under it. */}
                      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span className="font-mono text-sm font-medium tracking-wide uppercase">
                          {item.code}
                        </span>
                        <span className="text-muted-foreground truncate text-xs">{item.name}</span>
                      </span>

                      <span className="text-muted-foreground shrink-0 pt-0.5 text-xs whitespace-nowrap">
                        {item.meta}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {totals !== null ? (
              <p className="border-border text-muted-foreground border-t px-3 py-2 text-xs">
                {suggestionFooterText(totals.ok, hiddenCount, SUGGESTION_LIMIT)}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>

      {/* Result count, announced without stealing focus (core-form-inputs). */}
      <p className="sr-only" role="status" aria-live="polite">
        {isOpen && !isLoading && !suggestions.isError ? `${items.length} mã đăng được` : ""}
      </p>

    </div>
  );
}
