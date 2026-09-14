import { describe, expect, it } from "vitest";
import {
  CodexAuthUsageSource,
  ManualUsageFileSource,
  codexAuthPath,
  readCodexUsage,
} from "../src/codex-usage";
import { defaultCodexModels, matchCapability, resolveRoster } from "../src/index";
import type { ModelCapabilities } from "@vepando/switchyard-core";

const auth = {
  auth_mode: "chatgpt",
  tokens: { access_token: "token", account_id: "acct_1" },
};

const usageBody = {
  plan_type: "pro",
  rate_limit: {
    allowed: true,
    primary_window: {
      used_percent: 20,
      limit_window_seconds: 604800,
      reset_after_seconds: 302400,
      reset_at: 1789805393,
    },
  },
  model_usage: { "gpt-6-astra": { available: false } },
};

describe("codex usage", () => {
  it("reads quota from the codex login, not from a third-party app", async () => {
    const src = new CodexAuthUsageSource({
      readAuth: async () => auth,
      fetchFn: (async () => ({
        ok: true,
        status: 200,
        json: async () => usageBody,
      })) as never,
    });
    const reading = await src.read();
    expect(reading.usage?.remainingFraction).toBeCloseTo(0.8);
    // Half the window gone: 302400 of 604800 seconds.
    expect(reading.usage?.windowElapsedFraction).toBeCloseTo(0.5);
    expect(reading.usage?.resetsAtMs).toBe(1789805393000);
    expect(reading.modelAvailability?.["gpt-6-astra"]).toBe(false);
    expect(reading.planType).toBe("pro");
    expect(reading.source).toBe("codex-auth");
  });

  it("reports unknown instead of inventing a number when there is no login", async () => {
    const src = new CodexAuthUsageSource({
      readAuth: async () => {
        throw new Error("missing");
      },
    });
    const reading = await src.read();
    expect(reading.usage).toBeUndefined();
    expect(reading.note).toContain("no codex login");
  });

  it("refuses an API-key login: that is not ChatGPT quota", async () => {
    const src = new CodexAuthUsageSource({
      readAuth: async () => ({ auth_mode: "apikey", tokens: { access_token: "k" } }),
    });
    const reading = await src.read();
    expect(reading.usage).toBeUndefined();
    expect(reading.note).toContain("not a ChatGPT login");
  });

  it("falls through the chain and reports every reason", async () => {
    const reading = await readCodexUsage([
      new CodexAuthUsageSource({
        readAuth: async () => {
          throw new Error("missing");
        },
      }),
      new ManualUsageFileSource("/nonexistent/codex-usage.json"),
    ]);
    expect(reading.usage).toBeUndefined();
    expect(reading.source).toBe("none");
    expect(reading.note).toContain("codex-auth");
    expect(reading.note).toContain("file");
  });

  it("puts the auth file under the user home on every platform", () => {
    expect(codexAuthPath()).toContain(".codex");
  });
});

describe("codex roster resolution", () => {
  const catalog: ModelCapabilities[] = [
    {
      id: "openai/gpt-5.6-luna",
      provider: "openai",
      tier: "large",
      capabilityScore: 0.714,
      maxContextTokens: 1_050_000,
      pricing: {
        kind: "api",
        inputPer1M: { known: true, value: 0.2 },
        outputPer1M: { known: true, value: 0.8 },
      },
    },
    {
      id: "openai/gpt-5.6-luna:batch",
      provider: "openai",
      tier: "large",
      batchOnly: true,
      capabilityScore: 0.714,
      pricing: {
        kind: "api",
        inputPer1M: { known: true, value: 0.1 },
        outputPer1M: { known: true, value: 0.4 },
      },
    },
  ];

  it("takes the measured benchmark instead of the declared guess", () => {
    const luna = defaultCodexModels.find((m) => m.id === "codex-luna")!;
    const match = matchCapability(luna, catalog);
    expect(match.origin).toBe("benchmark");
    expect(match.capability).toBeCloseTo(0.714);
    // Cheaper :batch twin must not be the identity we adopt.
    expect(match.matchedCatalogId).toBe("openai/gpt-5.6-luna");
  });

  it("falls back to declared, then unknown, when nothing matches", () => {
    const luna = defaultCodexModels.find((m) => m.id === "codex-luna")!;
    expect(matchCapability(luna, []).origin).toBe("declared");
    expect(matchCapability({ ...luna, declaredCapability: undefined }, []).origin).toBe("unknown");
  });

  it("rewrites the roster with resolved scores", () => {
    const { specs } = resolveRoster(defaultCodexModels, catalog);
    expect(specs.find((s) => s.id === "codex-luna")?.declaredCapability).toBeCloseTo(0.714);
  });
});
