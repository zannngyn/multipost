import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

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

describe("create panel in a read-only session", () => {
  it("is not rendered at all, saving or not", () => {
    const readOnly = "Chế độ hỗ trợ chỉ được xem.";
    expect(panelIsOnScreen({ formOpen: true, readOnly, saving: false })).toBe(false);
    expect(panelIsOnScreen({ formOpen: true, readOnly, saving: true })).toBe(false);
  });
});
