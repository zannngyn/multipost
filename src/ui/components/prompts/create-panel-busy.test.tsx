import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  ACTIVATING_VERSION,
  SAVING_THIS_VERSION,
} from "@/ui/components/prompts/prompt-busy";
import { PromptVersionForm } from "@/ui/components/prompts/PromptVersionForm";
import {
  promptWriteAccess,
  showsCreatePanel,
} from "@/ui/components/prompts/prompt-write-access";

/**
 * The regression these render tests exist for: the create panel was gated on a
 * flag that meant "read-only OR busy", so submitting it unmounted it. The
 * refusal came back to an empty panel and the typed text was gone.
 *
 * `renderToStaticMarkup` rather than a DOM harness — the repo runs vitest in the
 * node environment (`vitest.config.ts`) and has no jsdom. It cannot click, but
 * it can prove exactly what is at stake here: WHAT IS ON SCREEN while a save is
 * in flight.
 */

const TYPED = {
  name: "GIONG-TET-2027",
  systemPrompt: "Bạn là copywriter.",
  body: "Viết cho {{product.name}} với {{constraints}}",
  changelog: "bỏ emoji ở câu mở",
  activate: false,
};

function countOf(html: string, pattern: RegExp): number {
  return html.match(pattern)?.length ?? 0;
}

/** Exactly the condition `PromptTemplatesScreen` renders the panel under. */
function panelIsOnScreen(input: { formOpen: boolean; readOnly: string | null; saving: boolean }) {
  const access = promptWriteAccess(input.readOnly);
  return showsCreatePanel({
    formOpen: input.formOpen,
    isReadOnly: access.isReadOnly,
    isBusy: input.saving,
  });
}

describe("create panel while a save is in flight", () => {
  it("stays on screen — busy is not a reason to unmount it", () => {
    expect(panelIsOnScreen({ formOpen: true, readOnly: null, saving: true })).toBe(true);
  });

  it("keeps every word the operator typed", () => {
    const html = renderToStaticMarkup(
      <PromptVersionForm
        nextVersion={3}
        pending
        defaultValues={TYPED}
        onSubmit={() => undefined}
        onCancel={() => undefined}
      />,
    );

    expect(html).toContain(TYPED.name);
    expect(html).toContain("{{product.name}}");
    expect(html).toContain(TYPED.changelog);
    // And the fields themselves are still there to type back into.
    expect(html).toContain("Tên phiên bản");
    expect(html).toContain("Nội dung prompt");
  });

  it("shows the save button working instead of a blank panel", () => {
    const html = renderToStaticMarkup(
      <PromptVersionForm nextVersion={3} pending onSubmit={() => undefined} />,
    );

    // `aria-busy` + the spinner only exist because the panel survived the click.
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('aria-label="Lưu phiên bản v3"');
  });

  it("keeps every quietened control focusable instead of dropping the keyboard", () => {
    const html = renderToStaticMarkup(
      <PromptVersionForm
        nextVersion={3}
        pending
        defaultValues={TYPED}
        onSubmit={() => undefined}
        onCancel={() => undefined}
      />,
    );

    // Astryx only swaps native `disabled` for `aria-disabled` when the control
    // carries a message to reach (Button.js, TextArea.js). A natively disabled
    // control that HAD focus — the save button just pressed, or the field it was
    // submitted from — sends the keyboard to <body> for the whole request.
    //
    // COUNTED, not just present: `toContain` passes while six of the seven
    // controls have gone native, and "one of them keeps focus" is not the
    // promise. Five fields + Lưu + Huỷ = 7, every one of them with a sentence.
    expect(countOf(html, /aria-disabled="true"/g)).toBe(7);
    expect(countOf(html, / disabled=""/g)).toBe(0);
  });

  it("leaves the controls usable again once the save settles", () => {
    const html = renderToStaticMarkup(
      <PromptVersionForm
        nextVersion={3}
        pending={false}
        defaultValues={TYPED}
        onSubmit={() => undefined}
      />,
    );

    expect(html).not.toContain('aria-busy="true"');
    expect(html).toContain(TYPED.name);
  });
});

/**
 * THE REVERSE LOCK (F1). The table refuses to activate while this panel is
 * saving; this is the same refusal read the other way round, and it was missing.
 *
 * "Lưu" can carry `activate: true`, so a save landing while an activation is in
 * flight leaves "bản nào đang chạy" decided by whichever response comes back
 * last — a coin toss over what the AI writes for every caption after it.
 */
describe("create panel while an ACTIVATION is in flight", () => {
  const BLOCKED = ACTIVATING_VERSION;

  function blockedPanel(): string {
    return renderToStaticMarkup(
      <PromptVersionForm
        nextVersion={3}
        pending={false}
        blockedReason={BLOCKED}
        defaultValues={TYPED}
        onSubmit={() => undefined}
        onCancel={() => undefined}
      />,
    );
  }

  it("locks the save button and says which request is holding it", () => {
    const html = blockedPanel();

    // The button is still there, still named — it is switched off, not removed.
    expect(html).toContain("Lưu phiên bản v3");
    // …and the reason rides in a tooltip, which is what keeps the button
    // `aria-disabled` (focusable) rather than natively disabled.
    expect(html).toContain('role="tooltip"');
    expect(html).toContain(BLOCKED);
  });

  it("locks the save button ONLY — typing is not a write", () => {
    // Exactly one control goes quiet: the one that would start the second
    // write. Taking the fields away from someone mid-sentence to report a
    // request they did not start is the worse trade.
    const html = blockedPanel();

    expect(countOf(html, /aria-disabled="true"/g)).toBe(1);
    expect(countOf(html, / disabled=""/g)).toBe(0);
    expect(html).toContain(TYPED.body.slice(0, 10));
  });

  it("does not claim to be saving when it is only waiting", () => {
    // No spinner: nothing of THIS form is in flight, and a spinner here would
    // report a request the operator never made from this panel.
    expect(blockedPanel()).not.toContain('aria-busy="true"');
  });

  it("says its own save first when both are true", () => {
    const html = renderToStaticMarkup(
      <PromptVersionForm
        nextVersion={3}
        pending
        blockedReason={BLOCKED}
        onSubmit={() => undefined}
        onCancel={() => undefined}
      />,
    );

    expect(html).toContain(SAVING_THIS_VERSION);
    expect(html).not.toContain(BLOCKED);
  });

  it("is a no-op when nothing is blocking", () => {
    const html = renderToStaticMarkup(
      <PromptVersionForm
        nextVersion={3}
        pending={false}
        blockedReason={null}
        defaultValues={TYPED}
        onSubmit={() => undefined}
        onCancel={() => undefined}
      />,
    );

    expect(countOf(html, /aria-disabled="true"/g)).toBe(0);
    expect(countOf(html, / disabled=""/g)).toBe(0);
  });
});

describe("create panel in a read-only session", () => {
  it("is not rendered at all, saving or not", () => {
    const readOnly = "Chế độ hỗ trợ chỉ được xem.";
    expect(panelIsOnScreen({ formOpen: true, readOnly, saving: false })).toBe(false);
    expect(panelIsOnScreen({ formOpen: true, readOnly, saving: true })).toBe(false);
  });
});
