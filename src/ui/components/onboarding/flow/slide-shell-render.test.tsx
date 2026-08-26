import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SlideShell } from "./SlideShell";

/**
 * The frame every screen sits in, pinned as markup.
 *
 * It is worth its own test file because the two-column rebuild moved things
 * that are load-bearing and invisible to a type check: the single <h1> and the
 * two escape routes now belong to the STORY column, not to the screen content.
 * The retired company slide used to draw sign-out, and its own test used to
 * guard it — that guard moved here with the button rather than being deleted.
 *
 * `renderToStaticMarkup`: vitest runs `environment: "node"` and there is no
 * jsdom in the repo.
 */

function render(props: Partial<Parameters<typeof SlideShell>[0]> = {}): string {
  return renderToStaticMarkup(
    <SlideShell
      id="count"
      direction={1}
      heading="Bạn đang quản lý bao nhiêu trang?"
      lead="Số trang bạn đang đăng bài, không tính trang cá nhân."
      {...props}
    >
      <p>Nội dung thao tác</p>
    </SlideShell>,
  );
}

describe("SlideShell — one heading, in the story column", () => {
  it("renders exactly one <h1>, carrying the screen title", () => {
    const html = render();
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(html).toContain("Bạn đang quản lý bao nhiêu trang?");
  });

  it("makes that heading programmatically focusable, so changing screen can announce itself", () => {
    // Focus is moved to it on every screen change; without tabindex a keyboard
    // or screen-reader user is left on a control that no longer exists.
    expect(render()).toContain('tabindex="-1"');
  });

  it("puts the heading BEFORE the action column in reading order", () => {
    const html = render();
    expect(html.indexOf("<h1")).toBeLessThan(html.indexOf("Nội dung thao tác"));
  });

  it("carries the lead and the screen's own content", () => {
    const html = render();
    expect(html).toContain("Số trang bạn đang đăng bài, không tính trang cá nhân.");
    expect(html).toContain("Nội dung thao tác");
  });

  it("states the position, so the story column answers 'how much is left'", () => {
    expect(render()).toContain("Bước 3/4");
  });
});

describe("SlideShell — where the story column puts things", () => {
  /**
   * Pinned as CLASSES, not as DOM order, because the defect was purely one of
   * spacing: the rail sat in the right place in the markup and was then shoved
   * to the bottom of the viewport, leaving ~600px of nothing in the middle of
   * the column and dropping the count under Next's dev-tools badge.
   */
  function bottomBlock(html: string): string {
    const match = html.match(/<div class="[^"]*md:mt-auto[^"]*">.*?<\/div><\/div>/);
    return match?.[0] ?? "";
  }

  it("keeps the position next to the words it belongs to, not pinned to the floor", () => {
    const html = render({ exitHref: "/" });
    expect(bottomBlock(html)).not.toContain("Bước 3/4");
  });

  it("pushes only the ways out to the foot of the column", () => {
    const html = render({ exitHref: "/" });
    expect(bottomBlock(html)).toContain("Vào ứng dụng");
  });

  it("reads heading, then lead, then position, then the ways out", () => {
    const html = render({ exitHref: "/" });
    const order = [
      "<h1",
      "Số trang bạn đang đăng bài, không tính trang cá nhân.",
      "Bước 3/4",
      "Vào ứng dụng",
    ];
    const positions = order.map((needle) => html.indexOf(needle));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(positions.every((index) => index >= 0)).toBe(true);
  });
});

describe("SlideShell — where the action column puts things", () => {
  it("follows its own left margin instead of floating in the middle", () => {
    // Centring the action column against a left-aligned story column read as a
    // misalignment: a ~300px dead gutter between the divider and the form.
    const html = render();
    const section = html.match(/<section class="([^"]*)"/)?.[1] ?? "";
    expect(section).not.toContain("mx-auto");
  });

  it("still caps the measure so a screen never runs edge to edge", () => {
    const section = render().match(/<section class="([^"]*)"/)?.[1] ?? "";
    expect(section).toMatch(/max-w-/);
  });
});

describe("SlideShell — the two escape routes", () => {
  it("offers sign-out when the page hands down the action", () => {
    // Withheld for a dev fake session by `(app)/layout.tsx`; a button that
    // submits nothing would be a dead control.
    expect(render({ signOutAction: async () => {} })).toContain("Đăng xuất");
  });

  it("draws no sign-out when there is no session to end", () => {
    expect(render()).not.toContain("Đăng xuất");
  });

  it("offers the way into the app as a real link, not a button", () => {
    const html = render({ exitHref: "/" });
    expect(html).toContain("Vào ứng dụng");
    expect(html).toMatch(/<a[^>]+href="\/"/);
  });

  it("draws no way into the app when the screen is not given one", () => {
    expect(render()).not.toContain("Vào ứng dụng");
  });
});

describe("SlideShell — moving on", () => {
  it("draws skip and back only when the flow allows them", () => {
    const bare = render();
    expect(bare).not.toContain("Để sau");
    expect(bare).not.toContain("Quay lại");

    const full = render({ onSkip: () => {}, onBack: () => {} });
    expect(full).toContain("Để sau");
    expect(full).toContain("Quay lại");
  });

  it("lets a screen rename its own skip", () => {
    expect(render({ onSkip: () => {}, skipLabel: "Bỏ qua bước này" })).toContain(
      "Bỏ qua bước này",
    );
  });
});
