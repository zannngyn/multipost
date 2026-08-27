import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ReadOnlyNotice } from "@/ui/components/feedback/ReadOnlyNotice";

/**
 * The bug this locks: `max-w-prose` was baked into the component. `max-width`
 * clamps the USED flex base size, so `basis-full` — a caller asking for a line
 * of its own under the buttons the notice explains — resolved to 65ch, still
 * fitted beside them, and the sentence read as a third button's label. Twice:
 * `BulkRunScreen` and the group rows in `ChannelGroupsScreen`.
 *
 * `renderToStaticMarkup`, like the other markup tests here: `vitest.config.ts`
 * runs `environment: "node"` and the repo has no jsdom.
 */

function classOf(markup: string): string {
  return markup.match(/class="([^"]*)"/)?.[1] ?? "";
}

function render(props: { reason: string | null; className?: string }): string {
  return renderToStaticMarkup(<ReadOnlyNotice {...props} />);
}

const REASON = "Chế độ hỗ trợ chỉ được xem.";

describe("ReadOnlyNotice", () => {
  it("says nothing at all when there is no reason", () => {
    expect(render({ reason: null })).toBe("");
    expect(render({ reason: "" })).toBe("");
  });

  it("announces itself without interrupting", () => {
    const markup = render({ reason: REASON });

    expect(markup).toContain('role="status"');
    expect(markup).toContain(REASON);
  });

  it("brings NO width of its own", () => {
    // The whole finding in one assertion: a component cannot know the box it is
    // dropped into, so it may not decide that box's width.
    expect(classOf(render({ reason: REASON }))).not.toMatch(/(^|\s)max-w-/);
  });

  it("lets a caller take a line of its own", () => {
    // `basis-full` with a `max-width` on top is a no-op; without one it wraps.
    const className = classOf(render({ reason: REASON, className: "basis-full" }));

    expect(className).toContain("basis-full");
    expect(className).not.toMatch(/(^|\s)max-w-/);
  });

  it("lets a caller ask for a reading measure instead", () => {
    expect(classOf(render({ reason: REASON, className: "max-w-prose" }))).toContain("max-w-prose");
  });
});

/**
 * The call sites, read as source: the component can no longer impose a width,
 * but a caller can still hand it one that cancels its own `basis-full`.
 */
describe("nobody asks for a full line and then caps it", () => {
  const CALLERS = [
    "../../bulk/BulkRunScreen.tsx",
    "../../channels/ChannelGroupsScreen.tsx",
    "../../prompts/PromptTemplatesScreen.tsx",
    "../../sync/CatalogSourceCard.tsx",
  ] as const;

  it.each(CALLERS)("%s", (file) => {
    const source = readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");
    const uses = [...source.matchAll(/<ReadOnlyNotice[^/]*\/>/g)].map((match) => match[0]);

    // A file listed here with no call site left is a stale entry, not a pass.
    expect(uses.length, `${file} no longer renders a ReadOnlyNotice`).toBeGreaterThan(0);
    for (const use of uses) {
      if (!use.includes("basis-full")) continue;
      expect(use, "basis-full and max-w- together: the wrap never happens").not.toContain("max-w-");
    }
  });
});
