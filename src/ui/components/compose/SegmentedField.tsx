"use client";

import type { UseFormRegisterReturn } from "react-hook-form";

import { cn } from "@/shared/utils";

/**
 * A short, fixed choice drawn as one segmented track — the "Kiểu bài" row of the
 * approved compose design.
 *
 * Still a native radio group underneath: `<fieldset>` + `<legend>` is what makes
 * it a group for assistive tech, and the real `<input type="radio">` keeps
 * arrow-key navigation, label activation and the announced role. Only the paint
 * is ours (core-form-inputs: native first, and here native is enough).
 *
 * Use it for choices whose options are self-explanatory in two words. When each
 * option needs a sentence of its own to be understood, this control has nowhere
 * to put it.
 *
 * Two ways to drive it, because the compose screen needs both:
 *  - `register` — a plain form field (nguồn ảnh), owned by react-hook-form;
 *  - `onValueChange` — a choice that maps onto SEVERAL form fields ("Kiểu bài"
 *    is `mediaKind` + `videoTarget` at once), which no single registration can
 *    express. Exactly one of the two must be given.
 */
export function SegmentedField({
  legend,
  name,
  options,
  register,
  onValueChange,
  value,
  disabled,
  error,
  className,
}: {
  legend: string;
  name: string;
  options: readonly { value: string; label: string; hint?: string }[];
  register?: UseFormRegisterReturn;
  /** Used when the choice is not one form field. Ignored when `register` is set. */
  onValueChange?: (value: string) => void;
  /** Current value — shows the active option's hint, and ticks the radio in
      the controlled mode. */
  value: string;
  disabled?: boolean;
  error?: string;
  className?: string;
}) {
  const hintId = `${name}-hint`;
  const errorId = `${name}-error`;
  const activeHint = options.find((option) => option.value === value)?.hint ?? null;

  return (
    <fieldset
      className={cn("flex min-w-0 flex-col gap-1.5", className)}
      aria-describedby={error ? `${errorId} ${hintId}` : hintId}
      aria-invalid={Boolean(error)}
    >
      {/* <legend> must stay the first child of <fieldset>: moving it into a
          wrapper to sit it beside the track would drop the group's name. */}
      <legend className="text-muted-foreground text-xs">{legend}</legend>

      {/* Track and pill sized as the ComposeFocus template draws them
          (lines 61–63): 4px inset track, 38px pills, accent text when active. */}
      <div className="bg-muted inline-flex w-fit max-w-full gap-1 overflow-x-auto rounded-xl p-1">
        {options.map((option) => (
          <label
            key={option.value}
            htmlFor={`${name}-${option.value}`}
            className={cn(
              "text-muted-foreground has-checked:bg-card has-checked:text-primary has-focus-visible:ring-ring/50 flex h-9.5 cursor-pointer items-center rounded-md px-5 text-sm whitespace-nowrap transition-colors has-checked:font-semibold has-checked:shadow-sm has-focus-visible:ring-3",
              disabled && "cursor-not-allowed opacity-60",
            )}
          >
            {register ? (
              <input
                {...register}
                id={`${name}-${option.value}`}
                type="radio"
                value={option.value}
                disabled={disabled}
                className="sr-only"
              />
            ) : (
              <input
                id={`${name}-${option.value}`}
                name={name}
                type="radio"
                value={option.value}
                checked={value === option.value}
                disabled={disabled}
                onChange={() => onValueChange?.(option.value)}
                className="sr-only"
              />
            )}
            {option.label}
          </label>
        ))}
      </div>

      <p id={hintId} className="text-muted-foreground text-xs leading-relaxed">
        {activeHint ?? ""}
      </p>

      {error ? (
        <p id={errorId} role="alert" className="text-destructive text-xs">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}
