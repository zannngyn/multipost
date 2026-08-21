"use client";

import { Dialog as DialogPrimitive } from "radix-ui";
import * as React from "react";

import { cn } from "@/shared/utils";

/**
 * Modal primitive, wrapping Radix Dialog.
 *
 * Why not hand-written (web-crud-inline-edit rule 3 + core-component-reuse): a
 * self-written focus trap always misses a case. Radix gives focus in on open,
 * focus back to the trigger on close, `Esc`, `aria-modal`, and `inert` on the
 * page behind — none of which is optional for an operator tool.
 *
 * Every colour, radius and z-index comes from the design tokens in globals.css
 * (core-design-tokens): no literal hex, no magic z-index number.
 */

const Dialog = DialogPrimitive.Root;
const DialogClose = DialogPrimitive.Close;

function DialogContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content>) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay
        data-slot="dialog-overlay"
        // Scrim tinted with the app's ink, not pure black: on a warm wash a
        // black veil reads cold and grey (core-design-tokens §dark mode / the
        // same reason the hairlines are ink at low alpha).
        className="fixed inset-0 z-50 bg-foreground/50 data-[state=open]:motion-safe:animate-in data-[state=open]:motion-safe:fade-in-0 data-[state=closed]:motion-safe:animate-out data-[state=closed]:motion-safe:fade-out-0"
      />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        className={cn(
          "bg-background fixed top-1/2 left-1/2 z-50 grid w-[calc(100vw-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 gap-4 rounded-xl border p-6 shadow-lg",
          // A dialog taller than the viewport must scroll, not clip its buttons.
          "max-h-[calc(100vh-2rem)] overflow-y-auto",
          className,
        )}
        {...props}
      >
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("space-y-1.5", className)} {...props} />;
}

function DialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn("text-lg font-semibold tracking-tight", className)}
      {...props}
    />
  );
}

/** Required by Radix: an unlabelled dialog is unusable with a screen reader. */
function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn("text-muted-foreground text-sm", className)}
      {...props}
    />
  );
}

function DialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("flex flex-wrap items-center justify-end gap-2 border-t pt-4", className)}
      {...props}
    />
  );
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
};
