"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";

/**
 * Client providers for the whole app. `children` are passed in from the Server
 * Component layout, so wrapping here does NOT turn the page tree into client
 * components (web-component-reuse rule 1).
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

  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
