"use client";

import { useRef, useState } from "react";

import { cn } from "@/shared/utils";

/**
 * The list every step of `GoogleDrivePicker` is made of: folders, spreadsheets,
 * sheet tabs. One component, three uses (core-component-reuse) — the rows only
 * differ in what they say, not in how they behave.
 *
 * Keyboard (web-accessibility, composite widget): the list is ONE tab stop.
 * Arrows move between rows, Home/End jump to the ends, Enter/Space activate —
 * so an operator does not have to press Tab forty times to reach the last
 * folder of a page. Every row is a real <button>, so the focus ring, Enter and
 * screen-reader semantics come from the platform instead of being re-invented.
 */

export interface PickerRow {
  /** Stable identity — the Drive id, or the tab name for step 3. */
  key: string;
  label: string;
  /** Secondary line, e.g. a shortened id. */
  hint?: string;
  isSelected?: boolean;
}

export function PickerList({
  ariaLabel,
  rows,
  onSelect,
  isBusy = false,
}: {
  ariaLabel: string;
  rows: readonly PickerRow[];
  onSelect: (key: string) => void;
  /** A background page load: rows stay usable, they just look muted. */
  isBusy?: boolean;
}) {
  const listRef = useRef<HTMLUListElement>(null);
  const [activeIndex, setActiveIndex] = useState(0);

  /**
   * The rows changed under us (navigated into a folder, search settled). The
   * roving tab stop has to go back to the top, otherwise Tab lands on a row
   * index that no longer exists and focus falls out of the list.
   */
  const signature = `${rows.length}:${rows[0]?.key ?? ""}`;
  const [lastSignature, setLastSignature] = useState(signature);
  if (lastSignature !== signature) {
    setLastSignature(signature);
    setActiveIndex(0);
  }

  function focusIndex(index: number) {
    const clamped = Math.max(0, Math.min(index, rows.length - 1));
    setActiveIndex(clamped);
    const buttons = listRef.current?.querySelectorAll<HTMLButtonElement>("[data-picker-row]");
    buttons?.item(clamped)?.focus();
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLUListElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      focusIndex(activeIndex + 1);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      focusIndex(activeIndex - 1);
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      focusIndex(0);
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      focusIndex(rows.length - 1);
    }
  }

  return (
    <ul
      ref={listRef}
      aria-label={ariaLabel}
      aria-busy={isBusy || undefined}
      onKeyDown={handleKeyDown}
      className={cn(
        "border-border bg-card divide-border max-h-72 divide-y overflow-y-auto rounded-xl border",
        isBusy && "opacity-70",
      )}
    >
      {rows.map((row, index) => (
        <li key={row.key}>
          <button
            type="button"
            data-picker-row
            // Roving tab stop: exactly one row is reachable with Tab.
            tabIndex={index === activeIndex ? 0 : -1}
            aria-current={row.isSelected ? "true" : undefined}
            onFocus={() => setActiveIndex(index)}
            onClick={() => onSelect(row.key)}
            className={cn(
              "focus-visible:ring-ring/50 hover:bg-muted flex w-full items-baseline justify-between gap-3 px-3.5 py-2.5 text-left text-sm outline-none focus-visible:ring-3",
              row.isSelected && "bg-muted/60 font-medium",
            )}
          >
            <span className="min-w-0 truncate">{row.label}</span>
            {row.hint ? (
              <span className="text-muted-foreground shrink-0 font-mono text-xs">{row.hint}</span>
            ) : null}
          </button>
        </li>
      ))}
    </ul>
  );
}

/**
 * Same box, same row height as the real list, so nothing jumps when the page
 * lands (web-feedback-states rule 1: CLS = 0). `aria-hidden` because a screen
 * reader gains nothing from grey boxes — the picker's live region says "đang
 * tải".
 */
export function PickerListSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div
      aria-hidden="true"
      className="border-border bg-card divide-border divide-y overflow-hidden rounded-xl border motion-safe:animate-pulse"
    >
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="flex items-center justify-between gap-3 px-3.5 py-3">
          <div className="bg-muted h-4 w-48 rounded" />
          <div className="bg-muted h-3 w-16 rounded" />
        </div>
      ))}
    </div>
  );
}
