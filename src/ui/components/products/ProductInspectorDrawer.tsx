"use client";

import { Dialog, DialogHeader, Layout, LayoutContent, useMediaQuery } from "@astryxdesign/core";

import type {
  InspectorRecoveryAction,
  ProductInspectorState,
} from "@/ui/components/products/product-inspector-state";
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
 * `purpose="info"`: this is a place to READ, so Escape closes it and nothing
 * here is a draft a stray dismissal could lose — the selection lives in the URL,
 * and the one action navigates.
 *
 * What `purpose="info"` does NOT buy here is closing by tapping outside. That
 * dismissal fires only for a click whose target is the <dialog> itself, i.e.
 * its ::backdrop — and `variant="fullscreen"` sizes the dialog to 100dvw ×
 * 100dvh, so nothing of the backdrop is left to reach. Escape and the header's
 * close button are the only two ways out, which is why passing `onOpenChange`
 * to DialogHeader below is mandatory and not decorative: without it a touch
 * user, who has no Escape key, would be shut in.
 */
export function ProductInspectorDrawer({
  state,
  isOpen,
  onClose,
  recovery,
}: {
  state: ProductInspectorState;
  isOpen: boolean;
  onClose: () => void;
  /**
   * The way out of the `missing` state, as a button INSIDE the modal. The copy
   * used to point at "Bỏ bộ lọc" and "Tải thêm", both of which sit on the page
   * behind — inert while the dialog is open, so the instruction could not be
   * followed without first guessing that the box had to be closed.
   */
  recovery: InspectorRecoveryAction | null;
}) {
  // Split-screen and folded phones get down here: below ~340px a label column
  // beside the value leaves too little room for the value. Hook first — the
  // early return below must not sit between renders with different hook counts.
  const stackLabels = useMediaQuery("(max-width: 340px)");

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
      /*
       * `fullscreen`, and NOT a `maxHeight` + `position` sheet. The sheet looked
       * more like a drawer and was a reflow bug (WCAG 1.4.10): a <dialog> with a
       * max-height has an INDEFINITE height, so `height: 100%` inside it does not
       * resolve, no descendant can become a scroll container, and the body is
       * simply clipped at the viewport edge. Measured at 195×422 the "Soạn bài"
       * button sat at y=945 and the wheel moved nothing — exactly the P1 bug this
       * component exists to fix, one layer down.
       * `fullscreen` gives the dialog a definite viewport-sized box, which is what
       * `Layout height="fill"` and the scrollable content region below need.
       */
      variant="fullscreen"
    >
      <Layout
        height="fill"
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
          // THIS is the scroll container — the one place in the drawer that owns
          // overflow, so a long product (conflict banner + note + block reason)
          // scrolls instead of running off the bottom edge.
          <LayoutContent padding={0} isScrollable>
            {/* h2 belongs to DialogHeader's title; the product code under it is
                h3, or the drawer would announce two peer headings. */}
            <ProductInspector
              state={state}
              headingLevel={3}
              recovery={recovery}
              labelPosition={stackLabels ? "top" : "start"}
            />
          </LayoutContent>
        }
      />
    </Dialog>
  );
}
