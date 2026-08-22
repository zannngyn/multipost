import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * The CALL SITE of the mount decision, as an invariant.
 *
 * `prompt-write-access.test.ts` proves `showsCreatePanel` ignores "busy"; that
 * is worth nothing if the screen stops asking it. The bug this guards against
 * has already shipped once: the panel was mounted behind a hand-written
 * `formOpen && !gate.isDisabled`, `isDisabled` meant "read-only OR busy", and
 * submitting the form unmounted it with the operator's text inside.
 *
 * WHY STRUCTURAL: `vitest.config.ts` runs `environment: "node"` and the repo
 * has no jsdom, so a test cannot click "Lưu" and watch the panel vanish. Same
 * trade as `components/read-only-sweep.test.ts`, and the same shape — read the
 * source, assert the wiring.
 *
 * It checks two things, because either one alone is trivial to slip past:
 *   1. the JSX mounts on a bare identifier, not on an expression;
 *   2. the identifier is a plain delegation to `showsCreatePanel`, with no
 *      boolean logic of its own.
 */

const SCREEN = "./PromptTemplatesScreen.tsx";
/** Anything that names the in-flight save. None of it may reach the guard. */
const BUSY_TOKENS = ["isSaving", "isPending", "isBusy", "isDisabled"] as const;

function read(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

/** The `{X ? (` line that opens the panel's ternary, found from its Card. */
function mountGuardLine(source: string): string {
  const lines = source.split("\n");
  const cardIndex = lines.findIndex((line) => line.includes("id={formPanelId}"));
  expect(cardIndex, "the create panel Card must carry id={formPanelId}").toBeGreaterThan(0);

  for (let index = cardIndex - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (line.includes("? (")) return line.trim();
  }
  throw new Error("no ternary opens the create panel");
}

/** Body of `const isCreatePanelVisible = showsCreatePanel({ … });`. */
function guardDeclaration(source: string): string {
  const match = source.match(
    /const isCreatePanelVisible = showsCreatePanel\(\{([\s\S]*?)\}\);/,
  );
  expect(match, "the guard must be one delegation to showsCreatePanel").not.toBeNull();
  return match![1];
}

describe("the create panel is mounted on read-only alone", () => {
  it("mounts on a bare identifier, not on an inline expression", () => {
    const line = mountGuardLine(read(SCREEN));
    expect(line).toBe("{isCreatePanelVisible ? (");
  });

  it("never names the in-flight save on the line that mounts it", () => {
    const line = mountGuardLine(read(SCREEN));
    for (const token of BUSY_TOKENS) {
      expect(line, `the mount guard must not consult ${token}`).not.toContain(token);
    }
  });

  it("delegates the decision instead of rebuilding it", () => {
    const source = read(SCREEN);
    expect(source).toContain("showsCreatePanel(");
    // Exactly once: two call sites means two answers waiting to disagree.
    expect(source.match(/showsCreatePanel\(/g)).toHaveLength(1);
  });

  it("hands `showsCreatePanel` its arguments and nothing else", () => {
    const declaration = guardDeclaration(read(SCREEN));
    // No `&&`, `||`, `!` or ternary: the moment the guard grows logic of its
    // own, "busy" can start deciding what is mounted again.
    for (const operator of ["&&", "||", "!", "?"]) {
      expect(
        declaration,
        `the guard must not compute anything itself (found "${operator}")`,
      ).not.toContain(operator);
    }
    // It must still pass busy in — that is the argument the helper documents as
    // deliberately ignored, and dropping it would hide the intent.
    expect(declaration).toContain("isBusy:");
    expect(declaration).toContain("isReadOnly:");
    expect(declaration).toContain("formOpen");
  });
});

/**
 * THE OTHER HALF OF THE LOCK (F1/F2).
 *
 * `PromptVersionForm` refuses to submit while `blockedReason` is set, and
 * `create-panel-busy.test.tsx` proves what that looks like. Neither can see
 * whether the SCREEN ever sets it — and if it does not, an operator can start a
 * save while an activation is in flight and the last response decides which
 * prompt version every future caption is written from.
 *
 * Structural for the same reason as everything above: no jsdom, no click, and
 * `activate.isPending` only becomes true inside a request this environment
 * cannot make.
 */
describe("the save button is locked while an activation is in flight", () => {
  /** The `blockedReason={…}` the screen hands to the form. */
  function blockedReasonProp(source: string): string {
    const match = source.match(/blockedReason=\{([^}]*)\}/);
    expect(match, "the screen must hand PromptVersionForm a blockedReason").not.toBeNull();
    return match![1].trim();
  }

  it("passes the form a reason keyed on the activation, not on a constant", () => {
    const prop = blockedReasonProp(read(SCREEN));

    // Named mutation, not a literal: `blockedReason={null}` would satisfy a
    // "prop is present" check while locking nothing at all.
    expect(prop).toContain("activate.isPending");
    expect(prop).not.toBe("null");
  });

  it("says which request is holding the button, from the shared sentence", () => {
    const prop = blockedReasonProp(read(SCREEN));

    // A bare `true`/`""` would disable the button with nothing to reach, and
    // Astryx would fall back to NATIVE disabled — dropping the keyboard on
    // <body> exactly when the operator pressed the thing.
    expect(prop).toContain("ACTIVATING_VERSION");
    expect(read(SCREEN)).toContain('from "@/ui/components/prompts/prompt-busy"');
  });

  it("keeps that sentence in one place, so the two screens cannot drift", () => {
    // The table says the same thing about the same request; two copies of one
    // sentence is how they stop being the same sentence.
    expect(read("./PromptVersionTable.tsx")).toContain("ACTIVATING_VERSION");
    expect(read("./prompt-busy.ts")).toContain("export const ACTIVATING_VERSION");
  });
});
