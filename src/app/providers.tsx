"use client";

import { InternationalizationProvider } from "@astryxdesign/core";
import type { MessagesByLocale } from "@astryxdesign/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";

import { ASTRYX_VI } from "@/ui/i18n/astryx-vi";

/**
 * Module scope, not an inline literal: a fresh object each render gives the
 * provider a new context value, and every Astryx component reading a string
 * re-renders for nothing.
 */
const ASTRYX_MESSAGES: MessagesByLocale = { vi: ASTRYX_VI };

/**
 * Client providers for the whole app. `children` are passed in from the Server
 * Component layout, so wrapping here does NOT turn the page tree into client
 * components (web-component-reuse rule 1).
 *
 * The locale sits here rather than in the app shell so the sign-in screen,
 * which renders outside it, speaks the same language as everything else.
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
            refetchOnWindowFocus: false,
            staleTime: 15_000,
          },
        },
      }),
  );

  return (
    // `html lang` is already "vi"; this is the same statement to Astryx, whose
    // own strings would otherwise render in English.
    <InternationalizationProvider locale="vi" messages={ASTRYX_MESSAGES}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </InternationalizationProvider>
  );
}
