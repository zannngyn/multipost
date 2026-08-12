import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Next 16 appends a block to CLAUDE.md on every dev/build run.
  // CLAUDE.md is the project contract for the agent team — keep it human-owned.
  agentRules: false,
};

export default nextConfig;
