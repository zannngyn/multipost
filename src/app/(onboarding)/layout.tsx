import type { ReactNode } from "react";

/**
 * The onboarding flow gets its OWN layout, sibling to `(app)`.
 *
 * That is what makes it genuinely full-screen: no `AppFrame`, no side nav, no
 * `TenantBoundary`. An overlay inside the app shell would still be boxed by the
 * shell's content area, and `TenantBoundary` would fight this route for control
 * of the "no company yet" state — the very state slide 01 exists to fix.
 */
export default function OnboardingLayout({ children }: { children: ReactNode }) {
  return <div className="bg-background text-foreground min-h-dvh">{children}</div>;
}
