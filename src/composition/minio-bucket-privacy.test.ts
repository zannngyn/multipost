import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * Locks the ONE line standing between a private MinIO bucket and every
 * tenant's photos being served to the open internet: `mc anonymous set none`
 * in `minio-init`'s entrypoint (docker-compose.yml). Nothing else notices if
 * that line is deleted — the stack still boots green, `minio-init` still
 * exits 0, and only a live probe against a real bucket would ever reveal the
 * bug (see task-11-report.md for exactly that probe).
 *
 * Also locks the FAIL-CLOSED ordering: `web`/`worker` must wait for
 * `minio-init` to finish (`service_completed_successfully`), not just for
 * `minio` to answer its healthcheck (`service_healthy`) — otherwise a
 * container can start serving uploads to a bucket that has not been made
 * private yet.
 *
 * And locks the `:?` (required) form on `minio`'s own root credentials.
 * MinIO treats an EMPTY MINIO_ROOT_USER/PASSWORD as "not set" and silently
 * falls back to minioadmin:minioadmin — `:-` or a bare `${...}` would let
 * that happen quietly on a port this compose file publishes; `:?` aborts
 * `up` instead. A "harmless cleanup" swap to `:-` would not be caught by
 * anything else here (the stack still boots, still looks private) — only a
 * live login with minioadmin/minioadmin would reveal it.
 */

const REPO_ROOT = join(import.meta.dirname, "..", "..");

function loadCompose(): Record<string, unknown> {
  const text = readFileSync(join(REPO_ROOT, "docker-compose.yml"), "utf8");
  return parse(text) as Record<string, unknown>;
}

interface ServiceDef {
  entrypoint?: string;
  depends_on?: Record<string, { condition?: string }>;
  environment?: Record<string, string>;
}

describe("MinIO bucket stays private", () => {
  const compose = loadCompose();
  const services = compose.services as Record<string, ServiceDef>;

  it("minio-init's entrypoint still sets the bucket to private", () => {
    const entrypoint = services["minio-init"]?.entrypoint ?? "";
    expect(entrypoint).toContain("mc anonymous set none");
  });

  for (const name of ["web", "worker"]) {
    it(`${name} waits for minio-init to finish, not just for minio to answer its healthcheck`, () => {
      const condition = services[name]?.depends_on?.["minio-init"]?.condition;
      expect(condition).toBe("service_completed_successfully");
    });
  }

  for (const [envVar, sourceVar] of [
    ["MINIO_ROOT_USER", "MINIO_ACCESS_KEY"],
    ["MINIO_ROOT_PASSWORD", "MINIO_SECRET_KEY"],
  ] as const) {
    it(`minio's ${envVar} still requires ${sourceVar} with the ':?' form`, () => {
      const value = services.minio?.environment?.[envVar] ?? "";
      // Must reference the ':?' required form, not ':-' (silent default) or
      // a bare interpolation (silently empty when unset) — either of those
      // lets MinIO fall back to minioadmin:minioadmin without a peep.
      expect(value).toContain(`\${${sourceVar}:?`);
    });
  }
});
