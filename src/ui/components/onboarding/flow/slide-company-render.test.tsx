import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SlideCompany } from "./SlideCompany";

/**
 * Slide 01 inherited the only two ways out of a screen that has no top bar and
 * no app behind it. Both were pinned here the moment `WizardRail` was deleted,
 * because losing either is invisible in a type check and fatal in production:
 * an invited employee would be made to found a second company, and an account
 * with no company would be stuck in the browser with no route to /signin.
 *
 * `renderToStaticMarkup`, like the other render tests in this repo: vitest runs
 * `environment: "node"` with no jsdom, and everything asserted here is in the
 * server-rendered HTML.
 */

function render(props: Partial<Parameters<typeof SlideCompany>[0]> = {}): string {
  // The two mutations need a client; nothing is fetched on mount.
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <SlideCompany onCreated={() => {}} onJoined={() => {}} {...props} />
    </QueryClientProvider>,
  );
}

describe("SlideCompany — the mandatory slide", () => {
  it("asks for the company name and offers the submit that continues the flow", () => {
    const html = render();
    expect(html).toContain("Tên công ty");
    expect(html).toContain("Tạo công ty và tiếp tục");
  });

  it("shows the slug as a preview line rather than a second box to fill in", () => {
    const html = render();
    expect(html).toContain("mysp.vn/");
    expect(html).not.toContain("Đường dẫn</label>");
  });

  it("leaves the slide's single <h1> to SlideShell", () => {
    // Two top-level headings on one slide breaks the flow's outline (spec §9),
    // and the rail already says which step this is.
    const html = render();
    expect(html).not.toContain("<h1");
    expect(html).not.toContain("Bước 01 / 02");
  });
});

describe("SlideCompany — escape 1: the invited employee", () => {
  it("keeps the invite-link door that WizardRail used to carry", () => {
    const html = render();
    expect(html).toContain("Đã có người mời bạn?");
    expect(html).toContain("Vào công ty bằng link mời");
  });

  it("names the door so it reads on its own, not only as a form", () => {
    const html = render();
    expect(html).toContain("Dán link mời để vào công ty của họ");
  });
});

describe("SlideCompany — escape 2: sign out", () => {
  it("offers sign-out when the page hands down the action", () => {
    const html = render({ signOutAction: async () => {} });
    expect(html).toContain("Đăng xuất");
  });

  it("draws nothing when there is no session to end (dev fake session)", () => {
    // `(app)/layout.tsx` withholds the action for a dev fake session; a button
    // that submits nothing would be a dead control.
    expect(render()).not.toContain("Đăng xuất");
  });
});
