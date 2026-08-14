"use client";

import { Button } from "@astryxdesign/core";

/**
 * Submit button for the sign-out form action. Astryx `Button` has no `asChild`,
 * and the surrounding form lives in a Server Component, so the button needs its
 * own client boundary.
 */
export function SignOutButton() {
  return <Button type="submit" variant="ghost" size="sm" label="Đăng xuất" />;
}
