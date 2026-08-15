/**
 * Which provider adapters a process ends up with (E4, single-provider decision
 * 15/08/2026). This is the branch that decides whether the system boots at all
 * without a Google key, so it gets its own test rather than being implied by the
 * gateway tests.
 */

import { describe, expect, it } from "vitest";

import { makeFakeLogger } from "@/core/ai/testing";

import { buildProviders } from "./ai-engine";
import { loadAiConfig } from "./config";

const OPENAI_ONLY = { OPENAI_API_KEY: "sk-openai" };

describe("buildProviders", () => {
  it("wires OpenAI alone when no Google key is configured", () => {
    const logger = makeFakeLogger();

    const providers = buildProviders(loadAiConfig(OPENAI_ONLY), logger);

    expect(Object.keys(providers)).toEqual(["openai"]);
    expect(providers.openai?.provider).toBe("openai");
    expect(providers.google).toBeUndefined();
  });

  // `GOOGLE_AI_API_KEY=` in a .env is the normal way to disable a provider; it
  // must take the same road as an absent variable, not a different one.
  it("treats a blank Google key exactly like a missing one", () => {
    const providers = buildProviders(
      loadAiConfig({ ...OPENAI_ONLY, GOOGLE_AI_API_KEY: "  " }),
      makeFakeLogger(),
    );

    expect(Object.keys(providers)).toEqual(["openai"]);
  });

  it("says out loud that Google is not wired, so the missing fallback is visible", () => {
    const logger = makeFakeLogger();

    buildProviders(loadAiConfig(OPENAI_ONLY), logger);

    const warning = logger.entries.find(
      (entry) => entry.level === "warn" && entry.message.includes("GOOGLE_AI_API_KEY"),
    );
    expect(warning).toBeDefined();
    expect(warning?.context).toMatchObject({ wired_providers: ["openai"] });
  });

  it("wires both providers when a Google key IS present — re-enabling needs no code change", () => {
    const providers = buildProviders(
      loadAiConfig({ ...OPENAI_ONLY, GOOGLE_AI_API_KEY: "AIza-paid" }),
      makeFakeLogger(),
    );

    expect(Object.keys(providers).sort()).toEqual(["google", "openai"]);
    expect(providers.google?.provider).toBe("google");
  });
});
