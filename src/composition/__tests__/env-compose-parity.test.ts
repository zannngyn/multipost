import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Every variable the deploy env files ship must be READ by compose.
 *
 * This test exists because the same bug shipped twice. `docker-compose.yml`
 * passes environment explicitly rather than through `env_file`, which is a
 * deliberate choice (each container carries only the secrets it uses). The cost
 * is that a variable can live in `deploy/env/*.env.example`, be filled in on the
 * VPS, and never reach the process — with no error anywhere, because every one
 * of these lists is legal when empty:
 *
 *   - `AUTH_FACEBOOK_ALLOWED_USER_IDS` was missing once and silently disabled
 *     Facebook sign-in in every container (see the comment in compose);
 *   - `AUTH_BOOTSTRAP_ADMINS` was missing again and left the deployment with no
 *     bootstrap admin at all, while `.env` on the box said otherwise.
 *
 * Neither was caught by typecheck, lint, tests or the deploy — the container
 * boots perfectly and just answers "no" to everyone. A string comparison of two
 * files is the only gate that sees it.
 */

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");

/**
 * Read by `docker compose` itself before any service is rendered, so it is
 * never interpolated into the file. The one legitimate absence.
 */
const COMPOSE_OWN_VARS = new Set(["COMPOSE_PROJECT_NAME"]);

function envVarNames(file: string): string[] {
  return readFileSync(join(REPO_ROOT, "deploy", "env", file), "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#") && line.includes("="))
    .map((line) => line.split("=")[0]!.trim());
}

/**
 * Deliberately NOT including docker-compose.override.yml: it is the local
 * development stack and never reaches the VPS, so a variable that only IT reads
 * is exactly the silent no-op this test exists to catch.
 */
function composeInterpolations(): Set<string> {
  const files = ["docker-compose.yml", "docker-compose.prod.yml"];
  const text = files.map((file) => readFileSync(join(REPO_ROOT, file), "utf8")).join("\n");
  return new Set([...text.matchAll(/\$\{([A-Z0-9_]+)/g)].map((match) => match[1]!));
}

describe("deploy env ↔ docker-compose parity", () => {
  const referenced = composeInterpolations();

  for (const file of ["prod.env.example"]) {
    it(`every variable in ${file} is read somewhere in compose`, () => {
      const declared = envVarNames(file).filter((name) => !COMPOSE_OWN_VARS.has(name));

      // Named rather than counted: the failure message has to say WHICH variable
      // silently does nothing, or the next person re-derives this bug by hand.
      const unread = declared.filter((name) => !referenced.has(name));
      expect(unread).toEqual([]);
    });
  }

  it("reads a non-trivial number of variables — a glob that matched nothing would pass", () => {
    expect(envVarNames("prod.env.example").length).toBeGreaterThan(20);
    expect(referenced.size).toBeGreaterThan(20);
  });
});
