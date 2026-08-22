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
