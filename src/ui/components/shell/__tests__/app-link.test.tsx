import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { LinkProvider, SideNav, SideNavItem, SideNavSection } from "@astryxdesign/core";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AppLink } from "@/ui/components/shell/AppLink";

/**
 * The side nav is the app's main navigation, and a nav row is only a link if
 * the anchor carries a real `href`: without one it cannot be focused, opened in
 * a new tab, middle-clicked, copied, or read as a link by a screen reader.
 *
 * WHAT WAS ACTUALLY WRONG (X1): the `href` was there. What was NOT supposed to
 * be there is `to` — Astryx wraps a custom link component to pass `to={href}`
 * alongside `href` for `to`-based routers, and Next's Link forwards the unknown
 * prop onto the anchor. Every nav row shipped `<a to="/posts" … href="/posts">`.
 * `AppLink` swallows it. Both facts are asserted here, because the fix must not
 * be able to remove the `href` while removing the `to`.
 *
 * `renderToStaticMarkup`, not a DOM test: `vitest.config.ts` runs
 * `environment: "node"` and the repo has no jsdom or testing-library (same note
 * as `calendar-render.test.tsx`). An anchor's attributes are server-rendered, so
 * this catches the regression without a new dependency.
 */

function navMarkup(): string {
  return renderToStaticMarkup(
    <LinkProvider component={AppLink}>
      <SideNav aria-label="Điều hướng chính">
        <SideNavSection title="Theo dõi">
          <SideNavItem href="/posts" label="Bài đăng" isSelected />
          <SideNavItem href="/compose" label="Soạn bài" />
        </SideNavSection>
      </SideNav>
    </LinkProvider>,
  );
}

describe("AppLink inside the side nav", () => {
  it("renders every destination as an anchor with a real href", () => {
    const anchors = navMarkup().match(/<a [^>]*>/g) ?? [];

    expect(anchors).toHaveLength(2);
    expect(anchors[0]).toContain('href="/posts"');
    expect(anchors[1]).toContain('href="/compose"');
  });

  it("does not leak Astryx's router-agnostic `to` prop onto the anchor", () => {
    for (const anchor of navMarkup().match(/<a [^>]*>/g) ?? []) {
      expect(anchor).not.toMatch(/\sto="/);
    }
  });

  it("keeps the current page marked for assistive tech", () => {
    // Same element, same render: whatever the adapter forwards, it must not
    // swallow the props Astryx sets ON the anchor.
    expect(navMarkup()).toContain('aria-current="page"');
  });
});

/**
 * The adapter is only worth anything if the shell actually uses it — an import
 * that drifts back to `NextLink` would put the `to` attribute on every link
 * again with nothing failing.
 */
describe("AppFrame wiring", () => {
  const source = readFileSync(fileURLToPath(new URL("../AppFrame.tsx", import.meta.url)), "utf8");
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

  it("hands AppLink to the one LinkProvider in the app", () => {
    expect(code).toContain("<LinkProvider component={AppLink}>");
    expect(code).not.toContain("next/link");
  });
});
