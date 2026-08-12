import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Self-contained server bundle for the Docker web image (deploy/E1.2).
  output: "standalone",
  // Next 16 appends a block to CLAUDE.md on every dev/build run.
  // CLAUDE.md is the project contract for the agent team — keep it human-owned.
  agentRules: false,
};

export default nextConfig;
