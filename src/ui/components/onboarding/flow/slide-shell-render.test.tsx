import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SlideShell } from "./SlideShell";

/**
 * The frame every slide sits in, pinned as markup.
 *
 * It is worth its own test file because the two-column rebuild moved things
 * that are load-bearing and invisible to a type check: the single <h1> and the
 * two escape routes now belong to the STORY column, not to the slide content.
 * `SlideCompany` used to draw sign-out, and its own test used to guard it —
 * that guard moved here with the button rather than being deleted.
 *
 * `renderToStaticMarkup`: vitest runs `environment: "node"` and there is no
 * jsdom in the repo.
 */

function render(props: Partial<Parameters<typeof SlideShell>[0]> = {}): string {
  return renderToStaticMarkup(
    <SlideShell
      id="facebook"
      direction={1}
      heading="Kết nối Facebook"
      lead="Nối fanpage sẽ nhận bài đăng."
      {...props}
    >
      <p>Nội dung thao tác</p>
    </SlideShell>,
  );
}

describe("SlideShell — one heading, in the story column", () => {
  it("renders exactly one <h1>, carrying the slide title", () => {
    const html = render();
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(html).toContain("Kết nối Facebook");
  });

  it("makes that heading programmatically focusable, so changing slide can announce itself", () => {
    // Focus is moved to it on every slide change; without tabindex a keyboard
    // or screen-reader user is left on a control that no longer exists.
    expect(render()).toContain('tabindex="-1"');
  });

  it("puts the heading BEFORE the action column in reading order", () => {
    const html = render();
    expect(html.indexOf("<h1")).toBeLessThan(html.indexOf("Nội dung thao tác"));
  });

  it("carries the lead and the slide's own content", () => {
    const html = render();
    expect(html).toContain("Nối fanpage sẽ nhận bài đăng.");
    expect(html).toContain("Nội dung thao tác");
  });

  it("states the position, so the story column answers 'how much is left'", () => {
    expect(render()).toContain("Bước 3/6");
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

  it("draws no way into the app on the slide that has no app yet", () => {
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

  it("lets a slide rename its own skip", () => {
    expect(render({ onSkip: () => {}, skipLabel: "Bỏ qua bước này" })).toContain(
      "Bỏ qua bước này",
    );
  });
});
