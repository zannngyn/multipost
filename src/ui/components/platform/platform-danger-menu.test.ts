import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * "Khoá công ty" is the heaviest action in the product — it takes a whole
 * customer offline — and it used to sit beside "Vào hỗ trợ" as a same-size
 * button one row apart from it (spec §3.2, lời hứa wave 1 §3.4). It now lives
 * behind the row's "⋯" menu as a DESTRUCTIVE item, while "Vào hỗ trợ" stays a
 * plain button: reading a customer's data is the lower bar, and burying it
 * would only make support slower.
 *
 * Two things must not drift back:
 *   1. the dangerous action stays inside the menu, marked destructive;
 *   2. the confirmation still demands a reason, validated at the boundary
 *      against the SAME schema the server enforces.
 *
 * WHY A STRUCTURAL TEST, NOT A RENDERING ONE: same reason as
 * `components/read-only-sweep.test.ts` and `members/members-hub-sweep.test.ts`
 * — `vitest.config.ts` runs `environment: "node"` and the repo has no jsdom or
 * testing-library, and adding either is a dependency decision this ticket does
 * not authorise. Deliberately coarse, so honest refactors survive while the
 * regression that actually happens — somebody putting the lock back on the row
 * because it is "one click faster" — fails loudly.
 */

function readSource(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

/**
 * Comments are stripped before EVERY assertion, positive ones included: both
 * files explain this decision in prose, so a comment naming `MoreMenu` would
 * satisfy the positive checks on a file that no longer renders one — the test
 * would go green on the exact regression it exists to catch.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

describe("platform: the dangerous action lives in the row's overflow menu", () => {
  const table = stripComments(readSource("./PlatformTenantTable.tsx"));

  it("renders the lock/unlock action as a MoreMenu item", () => {
    expect(table).toContain("MoreMenu");
    expect(table).toMatch(/<MoreMenu\b/);
    expect(table).toMatch(/label:\s*isSuspended\s*\?\s*"Mở khoá công ty"\s*:\s*"Khoá công ty"/);
  });

  it("marks locking — and only locking — as destructive", () => {
    expect(table).toMatch(/variant:\s*isSuspended\s*\?\s*undefined\s*:\s*"destructive"/);
  });

  it("no longer offers the lock as a bare button in the row", () => {
    // Exactly ONE button survives in a row, and it is the support door —
    // counted rather than pattern-matched, because a "no <Button> near Khoá"
    // regex reads straight past the support button into the menu items.
    expect(table.match(/<Button\b/g) ?? []).toHaveLength(1);
    expect(table).toMatch(/<Button[\s\S]*?Vào hỗ trợ/);
    // The reason box left the cell with the confirmation.
    expect(table).not.toContain("TextArea");
  });

  it("keeps the two-step: the menu only asks, it never writes", () => {
    // Selecting the item opens the confirmation; the mutation callbacks are
    // reached from `confirm`, never from the menu item.
    expect(table).toMatch(/onClick:\s*\(\)\s*=>\s*ask\(tenant\.id\)/);
    expect(table).toMatch(/function ask\([\s\S]*?setConfirmingId\(/);
    expect(table).toMatch(/function confirm\([\s\S]*?onActivate\([\s\S]*?onSuspend\(/);
    // `ask` is also where the row is remembered as the focus target, so the
    // keyboard has somewhere to go back to when the dialog closes.
    expect(table).toMatch(/function ask\([\s\S]*?returnFocusTo\.current\s*=/);
  });

  it("hands the keyboard back to the trigger when the confirmation closes", () => {
    // Astryx's Dialog restores focus to the MENU ITEM, which is gone by then,
    // so without this the keyboard lands on <body>.
    expect(table).toMatch(/useEffect\([\s\S]*?triggerRefs\.current\.get\(/);
    expect(table).toMatch(/<MoreMenu[\s\S]*?ref=\{/);
    // LOOKING the trigger up is not focusing it: both lines above pass on a
    // version that finds the button and does nothing with it — the same <body>
    // this exists to avoid. The call itself, inside the same effect.
    expect(table).toMatch(/useEffect\([\s\S]*?trigger\.focus\(\)[\s\S]*?\}, \[confirmingId\]\)/);
  });

  it("says out loud when the DATA cancelled the confirmation, not the operator", () => {
    // A dialog disappearing on its own reads as the app losing the click. Rule
    // 5 covers an action the app cancels as much as one it refuses — and focus
    // has just been moved to the list, so there is somewhere to read it from.
    expect(table).toMatch(/setDroppedNotice\(CONFIRMATION_DROPPED\)/);
    expect(table).toMatch(/role="status"[\s\S]*?aria-live="polite"/);
    // Mounted empty rather than conditionally: a live region that appears
    // together with its text is announced by nothing.
    expect(table).toMatch(/\{droppedNotice \?\? ""\}/);
    // …and a new confirmation clears yesterday's news.
    expect(table).toMatch(/function ask\([\s\S]*?setDroppedNotice\(null\)/);
  });

  it("drops the pending confirmation when its row leaves the answer", () => {
    // `confirmingTenant` is derived from the live list, so a refetch that drops
    // the row already takes the dialog off the screen — but `confirmingId`
    // would still point at it, and the next refetch bringing the row back would
    // reopen the confirmation nobody asked for, pre-armed to lock a company.
    // Anchored at two-space indent: that is the component body itself. Adjusted
    // DURING render, not in an effect — an effect would paint one frame still
    // carrying the stale id, and `react-hooks` rejects setState in an effect
    // body anyway. Four spaces would mean it slid inside one.
    // The block itself, anchored at two spaces and closed at two spaces, so a
    // slide into an effect (four) fails whatever it grew inside.
    const reset = table.match(
      /^ {2}if \(confirmingId !== null && confirmingTenant === null\) \{\n(?: {4}.*\n|\n)* {2}\}/m,
    );
    expect(reset, "the drop is no longer a plain `if` in the component body").not.toBeNull();
    expect(reset![0]).toContain("setConfirmingId(null);");
  });

  it("still has somewhere to put the keyboard when the trigger is gone too", () => {
    // The row that owned the "⋯" left with it, so `triggerRefs.get()` is empty.
    // Falling through to nothing means <body>, i.e. starting the page over.
    expect(table).toMatch(/listRef\.current\?\.focus\(\)/);
    expect(table).toMatch(/<Stack[\s\S]*?ref=\{listRef\}[\s\S]*?tabIndex=\{-1\}/);
  });
});

describe("platform: the confirmation still demands a reason", () => {
  const dialog = stripComments(readSource("./TenantStatusDialog.tsx"));

  it("validates the reason at the boundary with the shared schema", () => {
    expect(dialog).toContain("TenantStatusReasonFormSchema");
    expect(dialog).toMatch(/TenantStatusReasonFormSchema\.safeParse\(\{\s*reason\s*\}\)/);
    // A failed parse stops the write — it does not fall through to onConfirm.
    expect(dialog).toMatch(/if\s*\(!parsed\.success\)\s*\{[\s\S]*?return;\s*\}/);
  });

  it("hands the PARSED reason on, never the raw box", () => {
    expect(dialog).toMatch(/onConfirm\(tenant,\s*parsed\.data\.reason\)/);
    expect(dialog).not.toMatch(/onConfirm\([^)]*,\s*reason\s*\)/);
  });

  it("spends the confirm button while this row's write is in flight", () => {
    // Locking a company twice is not a double click anyone should be able to
    // make. `tooltip` is what keeps the button aria-disabled instead of
    // natively disabled, so pressing it does not drop the keyboard on <body>
    // — inside a modal, the worst place for it.
    expect(dialog).toMatch(/isLoading=\{isBusy\}/);
    expect(dialog).toMatch(/isDisabled=\{isBusy\}/);
    expect(dialog).toMatch(/tooltip=\{isBusy \? SAVING_MESSAGE : undefined\}/);
    // Never disabled for an empty reason: the box is checked on press.
    expect(dialog).not.toMatch(/isDisabled=\{[^}]*reason[^}]*\}/);
  });

  it("takes the row it confirms, not a maybe-row", () => {
    // The caller mounts this only when it has one, so a nullable prop was a
    // second, unreachable "closed" state to keep in sync with the first.
    expect(dialog).toMatch(/tenant: PlatformTenant;/);
    expect(dialog).not.toContain("if (!tenant) return null;");
  });

  it("spells out the consequence and keeps the reason required", () => {
    expect(dialog).toContain("suspendConsequence");
    expect(dialog).toContain("activateConsequence");
    expect(dialog).toContain("SUSPEND_REASON_MIN");
    expect(dialog).toContain("isRequired");
  });

  it("warns when the company being locked is MYSP's own", () => {
    expect(dialog).toContain("isInternalTenant");
  });
});
