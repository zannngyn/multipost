import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { getOperatorSession } from "@/app/_auth/session";
import { PromptTemplatesScreen } from "@/ui/components/prompts/PromptTemplatesScreen";

/**
 * "Mẫu prompt" (E10.7). Server Component guard, client screen.
 */

export const metadata: Metadata = {
  title: "Mẫu prompt AI — MYSP",
  robots: { index: false, follow: false },
};

/** Session-dependent: never prerendered, never cached by a proxy. */
export const dynamic = "force-dynamic";

export default async function PromptsPage() {
  const session = await getOperatorSession("page:/prompts");

  // Defence in depth: middleware already blocks this route, but a Server
  // Component must not trust that it was reached through the guard.
  if (!session) redirect("/signin?returnUrl=%2Fprompts");

  // No container here: the screen owns its own frame (Layout + full-width
  // header band), same split as `/channels`, `/members` and `/bulk`. The
  // wrapper this used to add sat INSIDE that frame and bounded the header as
  // well, so the divider stopped short of the shell edge.
  return <PromptTemplatesScreen />;
}
