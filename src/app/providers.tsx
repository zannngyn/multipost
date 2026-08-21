"use client";

import { LinkProvider, Theme } from "@astryxdesign/core";
import { neutralTheme } from "@astryxdesign/theme-neutral/built";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import NextLink from "next/link";
import { useState, type ReactNode } from "react";

/**
 * Client providers for the whole app. `children` are passed in from the Server
 * Component layout, so wrapping here does NOT turn the page tree into client
 * components (web-component-reuse rule 1).
 *
 * WHY Theme AND LinkProvider LIVE HERE AND NOT IN THE SHELL:
 * `@astryxdesign/theme-neutral/theme.css` is imported globally by globals.css,
 * but every rule in it is wrapped in `@scope ([data-astryx-theme="neutral"])`.
 * That attribute only exists on the wrapper `<Theme>` renders. So a screen with
 * no Theme ancestor does not get the neutral theme at all — it falls back to
 * the core defaults, whose accent is `#0074e2`.
 *
 * While these two providers sat inside `shell/AppFrame`, every route outside
 * `(app)` — `/signin`, `/join/<token>`, and both error boundaries — rendered
 * Astryx components in that blue. Two accents in one product, and the two the
 * operator sees first are the wrong ones. Hoisting them to the root layout is
 * the fix; AppFrame no longer wraps, because a second Theme would only register
 * itself as a nested one.
 *
 * The Theme wrapper is `display: contents`, so it adds no box and cannot
 * disturb the body's flex column.
 *
 * `global-error.tsx` REPLACES the root layout, so it never sees this provider
 * and wraps its own subtree — see the note there.
 */
export function Providers({ children }: { children: ReactNode }) {
  // One client per browser tab, created in state so React's strict-mode double
  // render (and any re-render) does not throw the cache away.
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // Per-query retry policies decide; the default must not retry a 4xx.
            retry: false,
            // The operator leaves the tab, the worker keeps writing, and coming
            // back to yesterday's numbers is the complaint this default fixes.
            // `staleTime` still gates it, so tabbing back and forth does not
            // turn into a refetch per focus event.
            refetchOnWindowFocus: true,
            staleTime: 15_000,
          },
        },
      }),
  );

  return (
    <LinkProvider component={NextLink}>
      <Theme theme={neutralTheme}>
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      </Theme>
    </LinkProvider>
  );
}
