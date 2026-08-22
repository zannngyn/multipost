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
    expect(table).toMatch(/useEffect\([\s\S]*?triggerRefs\.current\.get\([\s\S]*?\)\?\.focus\(\)/);
    expect(table).toMatch(/<MoreMenu[\s\S]*?ref=\{/);
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
    expect(dialog).toMatch(/onConfirm\(target,\s*parsed\.data\.reason\)/);
    expect(dialog).not.toMatch(/onConfirm\([^)]*,\s*reason\s*\)/);
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
