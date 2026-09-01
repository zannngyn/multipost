"use client";

import { ChevronDown } from "lucide-react";

import { cn } from "@/shared/utils";

/**
 * The control that turns a folded row ("× 5 kênh") back into the channels it
 * stands for. One component for both /posts tables so the two disclosures
 * cannot drift apart (core-component-reuse).
 *
 * A real `<button aria-expanded aria-controls>`, not a row click: the row also
 * holds links and buttons, and a clickable row swallows them. The chevron is
 * decoration — the label already says "5 kênh", so colour and rotation carry
 * nothing on their own (core-accessibility §5).
 */
export function FoldToggle({
  isOpen,
  onToggle,
  controls,
  label,
  srSuffix,
}: {
  isOpen: boolean;
  onToggle: () => void;
  /** Id of the panel this opens — it exists whether open or closed. */
  controls: string;
  /** What the operator reads: "5 kênh". */
  label: string;
  /** Which row this belongs to, for a screen reader hearing it out of context. */
  srSuffix: string;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={isOpen}
      aria-controls={controls}
      className="text-foreground focus-visible:ring-ring -mx-1.5 inline-flex cursor-pointer items-center gap-1 rounded-md px-1.5 py-1 text-sm font-medium underline-offset-4 outline-none hover:underline focus-visible:ring-3"
    >
      <ChevronDown
        aria-hidden="true"
        className={cn(
          "size-4 shrink-0 motion-safe:transition-transform",
          isOpen ? "" : "-rotate-90",
        )}
      />
      {label}
      <span className="sr-only">
        {isOpen ? " — ẩn danh sách kênh" : " — xem danh sách kênh"}
        {srSuffix}
      </span>
    </button>
  );
}
