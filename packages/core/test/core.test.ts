import { describe, expect, it, vi } from "vitest";
import {
  capacityBlocked,
  defaultClassifierFloors,
  defaultQuotaConfig,
  effectiveInputPer1M,
  filterCandidates,
  inferKind,
  isUncertain,
  keywordClassification,
  ModelClassifier,
  pickCheapestClassifier,
  route,
  scarcity,
  scoreCandidate,
  type Classification,
  type ModelCapabilities,
} from "../src/index";

const api = (id: string, tier: string, inUsd: number, outUsd: number): ModelCapabilities => ({
  id,
  provider: "test",
  tier: tier as ModelCapabilities["tier"],
  maxContextTokens: 200_000,
  supportsTools: ["bash", "read", "write", "edit"],
  capabilityScore: 0.5,
  capabilities: { structuredOutput: true, toolCalling: true },
  pricing: {
    kind: "api",
    inputPer1M: { known: true, value: inUsd },
    outputPer1M: { known: true, value: outUsd },
  },
});

const subscription = (id: string, tier: string, amortized: number): ModelCapabilities => ({
  id,
  provider: "codex-subscription",
  tier: tier as ModelCapabilities["tier"],
  maxContextTokens: 400_000,
  supportsTools: ["bash", "read", "write", "edit"],
  pricing: {
    kind: "subscription",
    inputPer1M: { known: false },
    outputPer1M: { known: false },
    planAmortizedPer1M: { known: true, value: amortized },
  },
});

const cheap = api("cheap-small", "small", 0.25, 1.25);
const mid = api("balanced-mid", "mid", 3, 15);
const large = api("strong-large", "large", 15, 75);
const luna = subscription("codex-luna", "mid", 0.3);

describe("complexity", () => {
  it("infers kind from objective keywords", () => {
    expect(inferKind("fix the failing parser test")).toBe("debug");
    expect(inferKind("summarize the release notes")).toBe("summarize");
    expect(inferKind("design a migration plan")).toBe("plan");
  });

  it("matches veto's thresholds", () => {
    expect(keywordClassification({ objective: "build e2e CQRS infrastructure with event sourcing" }).complexity).toBe("complex");
    expect(keywordClassification({ objective: "implement authentication service" }).complexity).toBe("moderate");
    expect(keywordClassification({ objective: "create simple html page" }).complexity).toBe("simple");
  });

  it("flags answers near a threshold as uncertain", () => {
    const c = keywordClassification({ objective: "implement service" });
    expect(isUncertain(c)).toBe(true);
    expect(isUncertain({ ...c, score: 6 })).toBe(false);
  });
});

describe("quota", () => {
  it("keeps unknown pricing unknown instead of free", () => {
    expect(effectiveInputPer1M(luna, undefined).known).toBe(true); // amortized fallback
    const noAmortized = { ...luna, pricing: { ...luna.pricing, planAmortizedPer1M: { known: false as const } } };
    expect(effectiveInputPer1M(noAmortized, undefined).known).toBe(false);
  });

  it("raises the shadow price as quota drains and when ahead of pace", () => {
    expect(scarcity({ remainingFraction: 1, windowElapsedFraction: 0.5, source: "t" })).toBe(0);
    const onPace = scarcity({ remainingFraction: 0.5, windowElapsedFraction: 0.5, source: "t" });
    const ahead = scarcity({ remainingFraction: 0.5, windowElapsedFraction: 0.9, source: "t" });
    expect(ahead).toBeGreaterThan(onPace);
    expect(scarcity({ remainingFraction: 0, windowElapsedFraction: 1, source: "t" })).toBe(1);
  });

  it("makes quota that will expire unused cheap, and drained quota expensive", () => {
    const expiring = { available: true as const, usage: { remainingFraction: 0.95, windowElapsedFraction: 0.05, source: "t" } };
    const drained = { available: true as const, usage: { remainingFraction: 0.05, windowElapsedFraction: 0.9, source: "t" } };
    const a = effectiveInputPer1M(luna, expiring);
    const b = effectiveInputPer1M(luna, drained);
    expect(a.known && b.known && b.value > a.value * 10).toBe(true);
  });

  it("blocks known-unavailable capacity and never blocks unknown capacity", () => {
    expect(capacityBlocked({ available: false, reason: "rate limited" }, 0)).toBe(true);
    expect(capacityBlocked({ available: "unknown" }, 0)).toBe(false);
    expect(capacityBlocked(undefined, 0)).toBe(false);
  });
});

describe("scoring", () => {
  it("scores unknown cost at the floor, not as free", () => {
    const unknownPrice = { known: false as const };
    const knownCost = { known: true as const, value: 0.001 };
    const fit = scoreCandidate(
      { objective: "x" },
      "code-change",
      { ...luna, pricing: { ...luna.pricing, planAmortizedPer1M: { known: false as const } } },
      undefined,
      undefined,
      defaultQuotaConfig,
    );
    expect(fit.costFit).toBe(0.05);
    expect(unknownPrice.known).toBe(false);
    expect(knownCost.known).toBe(true);
  });

  it("prefers the cheaper viable model on an equal footing", () => {
    const task = { objective: "add a retry to the HTTP client", kind: "code-change" as const };
    const cls = keywordClassification(task);
    const d = route(task, [cheap, mid, large], cls);
    expect(d.model?.id).toBe("cheap-small");
    expect(d.effort).toBe("low");
  });

  it("prunes tiers below the complexity floor", () => {
    const task = { objective: "design microservices architecture", kind: "plan" as const };
    const d = route(task, [cheap, mid, large], keywordClassification(task));
    expect(d.complexity).toBe("complex");
    expect(d.model?.id).toBe("strong-large");
    expect(d.pruned.map((p) => p.model.id)).toEqual(["cheap-small", "balanced-mid"]);
  });

  it("requires admission for complex or high-risk tasks and for thin margins", () => {
    const hard = { objective: "design a distributed migration plan", kind: "plan" as const, risk: "high" as const };
    expect(route(hard, [cheap, mid, large], keywordClassification(hard)).admissionRequired).toBe(true);
    // Two identically priced candidates: only admission can separate them.
    const thin = { objective: "rename a variable", kind: "code-change" as const };
    const twin = api("cheap-twin", "small", 0.25, 1.25);
    expect(route(thin, [cheap, twin], keywordClassification(thin)).admissionRequired).toBe(true);
    // A 60x price gap leaves no doubt: no admission round trip needed.
    expect(route(thin, [cheap, large], keywordClassification(thin)).admissionRequired).toBe(false);
  });

  it("routes away from a model with exhausted capacity", () => {
    const task = { objective: "refactor the duplicated authentication service", kind: "refactor" as const };
    const cls = keywordClassification(task);
    const withCapacity = route(task, [cheap, mid, luna], cls, {
      capacity: { "codex-luna": { available: false, reason: "rate limited" } },
    });
    expect(withCapacity.model?.id).toBe("balanced-mid");
    const plenty = route(task, [cheap, mid, luna], cls, {
      capacity: {
        "codex-luna": { available: true, usage: { remainingFraction: 0.95, windowElapsedFraction: 0.05, source: "t" } },
      },
    });
    expect(plenty.model?.id).toBe("codex-luna");
  });

  it("fails closed when nothing survives", () => {
    const task = { objective: "design a distributed system", kind: "plan" as const };
    const d = route(task, [cheap], keywordClassification(task));
    expect(d.model).toBeNull();
    expect(d.reason).toContain("no viable candidate");
  });

  it("respects a cost ceiling", () => {
    const task = { objective: "summarize the notes", kind: "summarize" as const, maxCostUsd: 0.000001 };
    expect(filterCandidates(task, "summarize", "simple", [cheap, mid], {}).survivors).toHaveLength(0);
  });
});

describe("classifier", () => {
  const models = [api("micro", "small", 0.017, 0.112), api("nano", "small", 0.03, 0.13)];

  it("picks the cheapest API model, never a subscription or unknown price", () => {
    expect(pickCheapestClassifier([...models, luna])?.id).toBe("micro");
  });

  it("refuses :free and :batch models and models that cannot return JSON", () => {
    const free = { ...api("free", "small", 0, 0), freeTier: true };
    const batch = { ...api("b:batch", "small", 0.001, 0.002), batchOnly: true };
    const noJson = { ...api("nojson", "small", 0.001, 0.002), capabilities: { structuredOutput: false } };
    const good = api("good", "small", 0.05, 0.1);
    expect(pickCheapestClassifier([free, batch, noJson, good])?.id).toBe("good");
  });

  it("refuses an unmeasured classifier and one below the capability floor", () => {
    const unmeasured = { ...api("mystery", "small", 0.001, 0.002), capabilityScore: undefined };
    const weak = { ...api("weak", "small", 0.002, 0.004), capabilityScore: 0.05 };
    const ok = { ...api("ok", "small", 0.05, 0.1), capabilityScore: 0.3 };
    expect(pickCheapestClassifier([unmeasured, weak, ok])?.id).toBe("ok");
    // Opting out is possible, but it is deliberate, not default.
    expect(
      pickCheapestClassifier([unmeasured, ok], { ...defaultClassifierFloors, requireBenchmark: false })?.id,
    ).toBe("mystery");
  });

  it("does not call a model when the deterministic answer is confident", async () => {
    const complete = vi.fn(async () => ({ text: '{"complexity":"complex"}' }));
    const c = new ModelClassifier({ models, complete });
    const out = await c.classify({ objective: "create a simple hello world page" });
    expect(complete).not.toHaveBeenCalled();
    expect(out.source).toBe("keyword");
  });

  it("escalates when uncertain and falls back when the call fails", async () => {
    const uncertain: Classification = {
      kind: "code-change",
      complexity: "moderate",
      confidence: 0.4,
      source: "keyword",
      score: 1,
    };
    const complete = vi.fn(async () => {
      throw new Error("offline");
    });
    const c = new ModelClassifier({ models: [...models, mid, large], complete });
    const out = await c.classify({ objective: "implement service" });
    expect(keywordClassification({ objective: "implement service" }).score).toBe(uncertain.score);
    expect(out.degraded).toBe(true);
    expect(out.complexity).toBe("moderate");
  });

  it("uses the model answer and caches it", async () => {
    const complete = vi.fn(async () => ({ text: '{"complexity":"complex","confidence":0.93}' }));
    const c = new ModelClassifier({ models: [...models, mid, large], complete });
    const task = { objective: "implement service" };
    const first = await c.classify(task);
    const second = await c.classify(task);
    expect(first.complexity).toBe("complex");
    expect(first.source).toBe("model");
    expect(complete).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });
});
