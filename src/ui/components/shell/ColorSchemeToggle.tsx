"use client";

import { Button } from "@astryxdesign/core";
import { Moon, Sun } from "lucide-react";
import { useEffect } from "react";

import {
  COLOR_SCHEME_ATTRIBUTE,
  DARK_SCHEME_CLASS,
  buildColorSchemeCookie,
  parseColorSchemeCookie,
} from "@/shared/color-scheme";

/**
 * One icon. Press it, the scheme flips.
 *
 * A PER-VIEWER preference, deliberately NOT the platform appearance setting:
 * one admin picks the product's colour for everybody, but light-or-dark is each
 * operator's own, and the two live in different places for that reason. Every
 * preset already ships both schemes (`presets.css`), so this only chooses which
 * half of an existing palette is shown.
 *
 * NO REACT STATE, AND THAT IS THE POINT. The scheme in force lives in one place
 * — the `dark` class on `<html>`, put there by the server or by the bootstrap
 * script before paint. Mirroring it into `useState` would mean the server
 * renders one icon and the client corrects it on hydration: a control that
 * changes under the cursor, plus a React mismatch on every load. So:
 *
 *   - WHICH ICON is decided by CSS. Both are rendered and the `dark:` variant
 *     hides one. That is correct in the very first frame, in every scheme,
 *     including "theo máy" — which the server cannot resolve at all.
 *   - THE LABEL never names the current state ("Đổi chế độ sáng tối", not
 *     "Chuyển sang tối"), so it cannot be wrong for the frame before hydration.
 *   - THE CLICK reads the live class rather than a remembered value.
 *
 * It writes the cookie and the class itself instead of calling the server: a
 * display preference with no business meaning, and a round trip would leave the
 * screen in the old scheme until the response came back. The server reads the
 * same cookie on the next load, which is what stops it flashing back.
 */
export function ColorSchemeToggle() {
  /**
   * Follow the operating system while — and only while — the choice is still
   * "theo máy". Without this, somebody who never pressed the button and whose
   * machine switches at sunset keeps the old scheme until they reload.
   *
   * The choice is re-read from the DOM on every event rather than captured:
   * pressing the button changes it, and a captured value would keep listening
   * after the operator has taken manual control.
   */
  useEffect(() => {
    const query = window.matchMedia("(prefers-color-scheme: dark)");

    const apply = () => {
      const root = document.documentElement;
      const choice = parseColorSchemeCookie(root.getAttribute(COLOR_SCHEME_ATTRIBUTE));
      if (choice !== "system") return;
      root.classList.toggle(DARK_SCHEME_CLASS, query.matches);
    };

    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }, []);

  function toggle() {
    const root = document.documentElement;
    const next = root.classList.contains(DARK_SCHEME_CLASS) ? "light" : "dark";

    root.classList.toggle(DARK_SCHEME_CLASS, next === "dark");
    // Pressing the button is taking manual control: the choice stops being
    // "theo máy", so the listener above lets go.
    root.setAttribute(COLOR_SCHEME_ATTRIBUTE, next);

    try {
      // `secure` mirrors the page: the dev box runs plain http, where a Secure
      // cookie is silently dropped and the choice would not survive a reload.
      document.cookie = buildColorSchemeCookie(next, {
        secure: window.location.protocol === "https:",
      });
    } catch (error) {
      // Cookies blocked (sandboxed iframe, hardened browser). Logged, not
      // rethrown: this runs inside a click handler, where a throw reaches no
      // error boundary and would only break a working toggle. The scheme still
      // flips — the choice just will not survive the reload. Same rule the nav
      // collapse cookie follows.
      console.warn("[shell] could not persist the colour scheme", {
        error_code: "COLOR_SCHEME_PERSIST_FAILED",
        color_scheme: next,
        err: error,
      });
    }
  }

  return (
    <Button
      // Never names the current state — see the header. It is the same sentence
      // whichever scheme is on, so it is right in the pre-hydration frame too.
      label="Đổi chế độ sáng tối"
      tooltip="Đổi chế độ sáng tối"
      isIconOnly
      size="sm"
      variant="ghost"
      icon={
        <>
          <Sun className="dark:hidden" aria-hidden="true" />
          <Moon className="hidden dark:block" aria-hidden="true" />
        </>
      }
      onClick={toggle}
    />
  );
}
