"use client";

import { IconButton, Stack, TextInput } from "@astryxdesign/core";
import type { TextInputProps } from "@astryxdesign/core";
import { Eye, EyeOff } from "lucide-react";

/**
 * A password box with the show/hide control INSIDE the field.
 *
 * One component rather than the same twelve lines in three places — the two
 * boxes on /signin and the one in the admin reset dialog (core-component-reuse
 * §"Cây decision", bậc 2). Getting this wrong in one copy is how a form ends up
 * with a toggle that submits itself.
 *
 * WHY AN OVERLAY: Astryx's `TextInput` has slots for a leading icon, a clear
 * button and a status icon, but none for an arbitrary trailing control, and it
 * renders label + control + status as one tree — so the button is positioned
 * over the control instead. The input gets its own end padding so a long
 * password never runs under the button.
 *
 * WHY `top` AND NOT A VERTICAL CENTRING: the field grows DOWNWARD when a
 * refusal appears under it (`statusVariant="detached"` puts the message inside
 * the field, measured), so anything anchored to the middle or the bottom drifts
 * the moment the password is rejected. Measured in the browser: the label row
 * is 24px and the control is 32px tall, so `top-6 mt-0.5` centres a 28px button
 * on the control and stays put whatever appears below.
 *
 * WHICH IS WHY `description` IS NOT ACCEPTED: a description sits between the
 * label and the control and moves it down by its own height — one line or two,
 * depending on the width. Say it under the field instead (the reset dialog
 * does), and this offset stays a constant rather than a guess.
 *
 * THE SAME INPUT, only its `type` changes — swapping in a second element would
 * drop what is being typed and break the password manager (web-auth-flows rule
 * 2). And the control is a real `<button type="button">` with an accessible
 * name, never a bare icon (web-auth-flows rule 2, web-accessibility): Astryx's
 * Button defaults `type` to `button`, so it cannot submit the form by accident.
 */
export function PasswordInput({
  isVisible,
  onToggleVisibility,
  ...inputProps
}: Omit<TextInputProps, "type" | "description"> & {
  isVisible: boolean;
  onToggleVisibility: () => void;
}) {
  const label = isVisible ? "Ẩn mật khẩu" : "Hiện mật khẩu";

  return (
    <Stack className="relative">
      <TextInput
        {...inputProps}
        type={isVisible ? "text" : "password"}
        className="[&_input]:pe-11"
      />
      {/* 24px label row + 2px to centre a 28px button on a 32px control; see
          the note above on why this is not a vertical centring. */}
      <IconButton
        variant="ghost"
        size="sm"
        label={label}
        tooltip={label}
        icon={isVisible ? <EyeOff aria-hidden /> : <Eye aria-hidden />}
        isDisabled={inputProps.isDisabled}
        onClick={onToggleVisibility}
        /* `z-10` is not decoration: Astryx's own control paints a stacking
           layer over this corner, and without it the input swallows every click
           on the button (caught by clicking it in a real browser). */
        className="absolute end-1 top-6 mt-0.5 z-10"
      />
    </Stack>
  );
}
