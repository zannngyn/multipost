import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { WelcomeScreen } from "../WelcomeScreen";

/**
 * `renderToStaticMarkup`, not testing-library: vitest runs `environment: "node"`
 * and the repo has no jsdom. `WelcomeScreen` takes the name and the handler as
 * props precisely so it stays renderable without a DOM and without a router.
 */

const noop = () => {};

describe("WelcomeScreen", () => {
  it("greets the operator by name", () => {
    const html = renderToStaticMarkup(<WelcomeScreen name="Vân" onStart={noop} />);
    expect(html).toContain("Vân");
  });

  it("carries exactly one <h1> — the flow's landmark heading", () => {
    const html = renderToStaticMarkup(<WelcomeScreen name="Vân" onStart={noop} />);
    expect(html.match(/<h1/g)).toHaveLength(1);
  });

  it("offers the way in", () => {
    const html = renderToStaticMarkup(<WelcomeScreen name="Vân" onStart={noop} />);
    expect(html).toContain("Bắt đầu");
  });

  it("draws no progress dots: the greeting asks nothing (spec section 3)", () => {
    const html = renderToStaticMarkup(<WelcomeScreen name="Vân" onStart={noop} />);
    expect(html).not.toContain("Bước");
  });

  it("still greets when the account has no display name on file", () => {
    // PENDING(welcome-name): /api/me carries no email, so there is no local
    // part to fall back to — the greeting has to stand without a name at all.
    const html = renderToStaticMarkup(<WelcomeScreen name={null} onStart={noop} />);
    expect(html).toContain("Chào");
    expect(html).toContain("Chào mừng tới MYSP");
    expect(html.match(/<h1/g)).toHaveLength(1);
  });

  it("hugs its label rather than stretching the button across the screen", () => {
    const html = renderToStaticMarkup(<WelcomeScreen name="Vân" onStart={noop} />);
    expect(html).not.toContain("w-full");
  });
});
