"use client";

import { Dialog, DialogHeader, Layout, LayoutContent } from "@astryxdesign/core";

import type { ProductInspectorState } from "@/ui/components/products/product-inspector-state";
import { ProductInspector } from "@/ui/components/products/ProductInspector";

/**
 * The inspector below 1024px, where there is no room for a 380px panel beside
 * the rows.
 *
 * The bug this closes (wave 1, P1): the panel was simply dropped on narrow
 * viewports, so tapping a code did nothing visible and "Soạn bài" — the only way
 * from this screen into the wizard — could not be reached on a phone or on a
 * split-screen tablet at all.
 *
 * `astryx docs layout` says an inspector should OVERLAY the content region below
 * ~1024px rather than compress it, but ships no drawer component (`astryx search
 * "drawer"` returns only MobileNav, which is navigation). A hand-rolled overlay
 * would have to re-implement focus trapping, Escape and page inertness; Dialog
 * is the sanctioned overlay and gets all three from the native <dialog>.
 *
 * `purpose="info"`: this is a place to READ, so both Escape and a tap outside
 * close it. Nothing here is a draft that a stray tap could lose — the selection
 * lives in the URL, and the one action navigates.
 */
export function ProductInspectorDrawer({
  state,
  isOpen,
  onClose,
}: {
  state: ProductInspectorState;
  isOpen: boolean;
  onClose: () => void;
}) {
  // Rendering the body of a closed drawer would keep a second copy of the
  // inspector (and its router hook) alive behind the page for nothing.
  if (!isOpen) return null;

  const subtitle =
    state.kind === "product"
      ? state.product.code
      : state.kind === "missing"
        ? state.code
        : undefined;

  return (
    <Dialog
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      purpose="info"
      // Pinned to the inline end and to the top, capped at the viewport: it
      // enters from the side the panel lives on above 1024px, so the same
      // information keeps the same place on screen. It grows with its content
      // and scrolls at 100dvh instead of always being a full-height slab — a
      // stretched empty column on a 900px tablet reads as a broken layout.
      // (`variant="fullscreen"` was the alternative and does exactly that.)
      width="min(420px, 100vw)"
      maxHeight="100dvh"
      position={{ top: 0, end: 0 }}
    >
      <Layout
        height="auto"
        header={
          <DialogHeader
            title="Chi tiết sản phẩm"
            subtitle={subtitle}
            // Passing this renders the close button. A drawer that only closed
            // on Escape would be a trap for a touch user.
            onOpenChange={(open) => {
              if (!open) onClose();
            }}
          />
        }
        content={
          // No padding here: DialogHeader brings its own inset and the inspector
          // body brings a matching one, so the two line up. A third from the
          // content slot would push the body out of line with the title.
          <LayoutContent padding={0}>
            <ProductInspector state={state} />
          </LayoutContent>
        }
      />
    </Dialog>
  );
}
