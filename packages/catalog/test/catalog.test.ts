import { describe, expect, it } from "vitest";
import { Catalog, CodexSubscriptionSource, detectCodexEnvironment, signalsFromCatalog, stats } from "../src/index";
import type { ModelSource, SourceResult } from "@vepando/switchyard-provider-openrouter";
import type { ModelCapabilities } from "@vepando/switchyard-core";

const model = (id: string, provider: string, tier: string, price?: number, score?: number): ModelCapabilities => ({
  id,
  provider,
  tier: tier as ModelCapabilities["tier"],
  capabilityScore: score,
  pricing: {
    kind: "api",
    inputPer1M: price === undefined ? { known: false } : { known: true, value: price },
    outputPer1M: price === undefined ? { known: false } : { known: true, value: price * 5 },
  },
});

function fakeSource(id: string, models: ModelCapabilities[], stale = false): ModelSource {
  return {
    id,
    async list(): Promise<SourceResult> {
      return { source: id, models, fetchedAt: Date.now(), stale };
    },
  };
}

describe("catalog", () => {
  it("merges every source into one pool and dedupes by id", async () => {
    const a = fakeSource("a", [model("x/1", "a", "mid", 1), model("shared", "a", "small", 0.1)]);
    const b = fakeSource("b", [model("shared", "b", "large", 9), model("y/2", "b", "mid", 2)]);
    const snap = await new Catalog([a, b]).refresh();
    expect(snap.models.map((m) => m.id)).toEqual(["shared", "x/1", "y/2"]);
    // Earlier source wins on a duplicate id.
    expect(snap.models.find((m) => m.id === "shared")?.provider).toBe("a");
  });

  it("keeps models we cannot price or score", async () => {
    const snap = await new Catalog([fakeSource("a", [model("mystery", "a", "unknown")])]).refresh();
    expect(snap.models).toHaveLength(1);
    expect(snap.models[0].pricing.inputPer1M.known).toBe(false);
  });

  it("reports per-source status including staleness", async () => {
    const snap = await new Catalog([
      fakeSource("live", [model("l/1", "live", "mid", 1)], false),
      fakeSource("cached", [model("c/1", "cached", "mid", 1)], true),
    ]).refresh();
    expect(snap.status.map((s) => [s.source, s.stale])).toEqual([
      ["live", false],
      ["cached", true],
    ]);
  });

  it("adds subscription models and their capacity state", async () => {
    const codex = new CodexSubscriptionSource(undefined, { hasBinary: true, hasLogin: true });
    const snap = await new Catalog([fakeSource("a", [model("x/1", "a", "mid", 1)])], codex).refresh();
    expect(snap.models.some((m) => m.id === "codex-sol")).toBe(true);
    // A detected login is not evidence of remaining quota.
    expect(snap.capacity["codex-sol"]).toEqual({ available: "unknown", reason: "logged in; quota not measured" });
  });

  it("marks subscription capacity unavailable when no login is detected", () => {
    const codex = new CodexSubscriptionSource(undefined, { hasBinary: false, hasLogin: false });
    expect(codex.list().capacity["codex-luna"]).toEqual({
      available: false,
      reason: "codex CLI or ChatGPT login not detected",
    });
  });

  it("builds cold-start signals from published benchmarks only", () => {
    const models = [model("scored", "a", "large", 5, 0.7), model("unscored", "a", "mid", 1)];
    const signals = signalsFromCatalog(models);
    expect(signals["scored"]?.evalScore).toBeCloseTo(0.7);
    expect(signals["scored"]?.successRate).toBeUndefined();
    expect(signals["unscored"]).toBeUndefined();
  });

  it("summarises the pool and finds the cheapest model per tier", () => {
    const s = stats([
      model("a", "p", "small", 0.1),
      model("b", "p", "small", 0.02),
      model("c", "p", "large", 15),
      model("d", "p", "unknown"),
    ]);
    expect(s.total).toBe(4);
    expect(s.withKnownPrice).toBe(3);
    expect(s.byTier).toEqual({ small: 2, large: 1, unknown: 1 });
    expect(s.cheapestPerTier["small"]?.id).toBe("b");
  });
});

describe("codex detection", () => {
  it("detects a stored login and a binary on PATH", async () => {
    const env = await detectCodexEnvironment({
      codexHome: "/tmp/definitely-missing-codex-home",
      lookPath: async () => "/usr/local/bin/codex",
    });
    expect(env).toEqual({ hasBinary: true, hasLogin: false });
  });
});
