import { afterEach, describe, expect, it, vi } from "vitest";

import type { AuthConfig } from "@/composition/config";

import { warnWhenNoBootstrapAdmin } from "../auth.config";

/**
 * N7 — the deployment-bricking configuration.
 *
 * `AUTH_ALLOWED_DOMAINS` used to be mandatory, which accidentally forced whoever
 * deployed to think about access at least once. Now that it is optional (and
 * blank in both deploy env examples), nothing stops a deployment where every
 * sign-in queues as `pending` and no one can approve it. This warning is the
 * only thing left that says so — hence a test on both directions.
 */

const BASE: AuthConfig = {
  GOOGLE_CLIENT_ID: "client-id",
  GOOGLE_CLIENT_SECRET: "client-secret",
  AUTH_ALLOWED_DOMAINS: undefined,
  AUTH_BOOTSTRAP_ADMINS: undefined,
  AUTH_FACEBOOK_ALLOWED_USER_IDS: undefined,
  SESSION_SECRET: "x".repeat(40),
};

function captureWarnings(): { lines: string[] } {
  const lines: string[] = [];
  vi.spyOn(console, "warn").mockImplementation((line: unknown) => {
    lines.push(String(line));
  });
  return { lines };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("warnWhenNoBootstrapAdmin — warns", () => {
  it("warns when BOTH bootstrap lists are empty", () => {
    const { lines } = captureWarnings();

    warnWhenNoBootstrapAdmin(BASE);

    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(entry.reason).toBe("NO_BOOTSTRAP_ADMIN");
    // CHANGED AT M2.4: self-service sign-up means nobody is stuck pending —
    // the consequence now is a missing EMERGENCY DOOR, and the message must
    // say that truthfully instead of the retired approval-queue story.
    expect(entry.message).toContain("NO emergency door");
    expect(entry.message).toContain("AUTH_BOOTSTRAP_ADMINS");
    expect(entry.user_message).toContain("không có lối vào dự phòng");
  });

  it("still warns when only a domain filter is configured — a domain grants nothing", () => {
    const { lines } = captureWarnings();

    warnWhenNoBootstrapAdmin({ ...BASE, AUTH_ALLOWED_DOMAINS: ["mysp.vn"] });

    expect(lines).toHaveLength(1);
  });

  it("warns on empty arrays, not just absent values", () => {
    const { lines } = captureWarnings();

    warnWhenNoBootstrapAdmin({
      ...BASE,
      AUTH_BOOTSTRAP_ADMINS: [],
      AUTH_FACEBOOK_ALLOWED_USER_IDS: [],
    });

    expect(lines).toHaveLength(1);
  });
});

/** The call site, not just the function: a check nobody calls warns nobody. */
describe("loadAuthEnv wires the warning", () => {
  const ENV = {
    GOOGLE_CLIENT_ID: "client-id",
    GOOGLE_CLIENT_SECRET: "client-secret",
    AUTH_ALLOWED_DOMAINS: "",
    AUTH_BOOTSTRAP_ADMINS: "",
    AUTH_FACEBOOK_ALLOWED_USER_IDS: "",
    SESSION_SECRET: "x".repeat(40),
  };

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("warns on the first read of an env with no bootstrap admin, and only once", async () => {
    vi.resetModules();
    for (const [key, value] of Object.entries(ENV)) vi.stubEnv(key, value);
    const { lines } = captureWarnings();

    // Fresh import: the parsed env is cached per module load.
    const { loadAuthEnv } = await import("../auth.config");
    loadAuthEnv();
    loadAuthEnv();

    expect(lines.filter((line) => line.includes("NO_BOOTSTRAP_ADMIN"))).toHaveLength(1);
  });

  it("says nothing when a bootstrap admin is configured", async () => {
    vi.resetModules();
    for (const [key, value] of Object.entries(ENV)) vi.stubEnv(key, value);
    vi.stubEnv("AUTH_BOOTSTRAP_ADMINS", "boss@mysp.vn");
    const { lines } = captureWarnings();

    const { loadAuthEnv } = await import("../auth.config");
    loadAuthEnv();

    expect(lines).toEqual([]);
  });
});

describe("warnWhenNoBootstrapAdmin — stays quiet", () => {
  it("says nothing when an e-mail bootstrap admin exists", () => {
    const { lines } = captureWarnings();

    warnWhenNoBootstrapAdmin({ ...BASE, AUTH_BOOTSTRAP_ADMINS: ["boss@mysp.vn"] });

    expect(lines).toEqual([]);
  });

  it("says nothing when only a Facebook bootstrap admin exists", () => {
    const { lines } = captureWarnings();

    warnWhenNoBootstrapAdmin({ ...BASE, AUTH_FACEBOOK_ALLOWED_USER_IDS: ["992710700450296"] });

    expect(lines).toEqual([]);
  });
});
