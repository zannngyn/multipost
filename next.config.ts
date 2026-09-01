import type { NextConfig } from "next";

/**
 * The four addresses the wave-1 IA retired, answered at the edge.
 *
 * WHY HERE AND NOT ONLY IN A PAGE: `src/app/(app)/{scheduled,jobs,access,
 * channels/groups}/page.tsx` already call `redirect()`, but that costs a React
 * render on the server and returns the redirect from inside the app router —
 * the browser only learns the new address after Next has booted a route. A
 * config redirect answers 307 before any page code runs, which is what a stale
 * bookmark or an external link deserves. The pages STAY as defence in depth:
 * this table is data in a config file, and a config file is the kind of thing
 * that gets a typo and is never noticed until an operator hits a 404.
 *
 * WHY THE TABLE IS SPELLED OUT AGAIN INSTEAD OF IMPORTED: `next.config.ts` is
 * loaded by Next's own config loader, outside the app's module graph and
 * without its `@/` path alias — importing `legacy-routes.ts` (which imports the
 * shared tab helper by alias) would break config loading. The duplication is
 * held to the source by a test: `legacy-routes.test.ts` asserts this table and
 * `LEGACY_ROUTES` say the same thing.
 *
 * `permanent: false` → 307, not 308: 308 is cached by the browser forever, and
 * "forever" is the wrong promise for an IA that is still moving. The query
 * string survives on its own — Next merges the incoming query into the
 * destination (`prepare-destination.ts`: initial URL query, then destination
 * query, destination wins), so `/jobs?status=failed` lands on
 * `/posts?status=failed&tab=log`.
 */
const LEGACY_REDIRECTS = [
  { source: "/scheduled", destination: "/posts?tab=scheduled" },
  { source: "/jobs", destination: "/posts?tab=log" },
  { source: "/channels/groups", destination: "/channels?tab=groups" },
  { source: "/access", destination: "/members?tab=history" },
] as const;

const nextConfig: NextConfig = {
  // Self-contained server bundle for the Docker web image (deploy/E1.2).
  output: "standalone",
  // Next 16 appends a block to CLAUDE.md on every dev/build run.
  // CLAUDE.md is the project contract for the agent team — keep it human-owned.
  agentRules: false,
  async redirects() {
    return LEGACY_REDIRECTS.map(({ source, destination }) => ({
      source,
      destination,
      permanent: false,
    }));
  },
};

export default nextConfig;
