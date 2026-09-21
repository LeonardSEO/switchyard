import { describe, expect, it, vi } from "vitest";
import {
  capacityBlocked,
  defaultClassifierFloors,
  defaultQuotaConfig,
  effectiveInputPer1M,
  filterCandidates,
  inferKind,
  classifierInput,
  classificationCost,
  isUncertain,
  keywordClassification,
  ModelClassifier,
  pickCheapestClassifier,
  route,
  scarcity,
  scoreCandidate,
  signalForTask,
  smoothedSuccessRate,
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

const subscription = (
  id: string,
  tier: string,
  amortized: number,
  capability = 0.5,
): ModelCapabilities => ({
  id,
  provider: "codex-subscription",
  tier: tier as ModelCapabilities["tier"],
  capabilityScore: capability,
  capabilityScoreSource: "declared",
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

  it("classifies tasks across all six complexity rungs", () => {
    expect(keywordClassification({ objective: "build e2e CQRS infrastructure with event sourcing" }).complexity).toBe("frontier");
    expect(keywordClassification({ objective: "design the service architecture" }).complexity).toBe("advanced");
    expect(keywordClassification({ objective: "implement authentication service" }).complexity).toBe("moderate");
    expect(keywordClassification({ objective: "create simple html page" }).complexity).toBe("simple");
    expect(keywordClassification({ objective: "create a simple hello world page" }).complexity).toBe("trivial");
  });

  it("flags answers near a threshold as uncertain", () => {
    // "deploy" scores exactly 1, which sits on the threshold.
    const c = keywordClassification({ objective: "deploy" });
    expect(isUncertain(c)).toBe(true);
    for (const score of [-3, 1, 3, 6, 8]) {
      expect(isUncertain({ ...c, score })).toBe(true);
    }
    expect(isUncertain({ ...c, score: 4 })).toBe(false);
  });
});

describe("outcome evidence", () => {
  it("shrinks sparse verified history toward the benchmark prior", () => {
    expect(
      smoothedSuccessRate({ successRate: 1, sampleCount: 1, effectiveSampleSize: 1 }, 0.6),
    ).toBeCloseTo(0.68);
    expect(
      smoothedSuccessRate({ successRate: 0, sampleCount: 1, effectiveSampleSize: 1 }, 0.6),
    ).toBeCloseTo(0.48);
    expect(
      smoothedSuccessRate({ successRate: 1, sampleCount: 100, effectiveSampleSize: 100 }, 0.6),
    ).toBeGreaterThan(0.98);
  });

  it("uses specific evidence only after it has enough samples", () => {
    const signals = {
      "m|debug": { successRate: 0.7, sampleCount: 10 },
      "m|debug|complex": { successRate: 0.2, sampleCount: 2 },
      "m|debug|complex|project": { successRate: 0.9, sampleCount: 3 },
    };
    expect(signalForTask(signals, "m", "debug", "complex", "project")?.successRate).toBe(0.9);
    expect(signalForTask(signals, "m", "debug", "complex", "other")?.successRate).toBe(0.7);
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
    const strong = { ...large, capabilityScore: 0.8 };
    const d = route(task, [cheap, mid, strong], keywordClassification(task));
    expect(d.complexity).toBe("frontier");
    expect(d.model?.id).toBe("strong-large");
    expect(d.pruned.map((p) => p.model.id)).toEqual(["cheap-small", "balanced-mid"]);
  });

  it("requires admission for complex or high-risk tasks and for thin margins", () => {
    const hard = {
      objective: "design a distributed microservices architecture migration plan",
      kind: "plan" as const,
      risk: "high" as const,
    };
    const strong = { ...large, capabilityScore: 0.8 };
    expect(route(hard, [cheap, mid, strong], keywordClassification(hard)).admissionRequired).toBe(true);
    // Two identically priced candidates: only admission can separate them.
    const thin = { objective: "rename a variable", kind: "code-change" as const, failureCostUsd: 0 };
    const twin = api("cheap-twin", "small", 0.25, 1.25);
    expect(route(thin, [cheap, twin], keywordClassification(thin)).admissionRequired).toBe(true);
    // A 60x price gap leaves no doubt: no admission round trip needed.
    // Priced without a failure cost on purpose: once failure has a price the
    // ordering shifts and this assertion would be about two things at once.
    expect(route(thin, [cheap, large], keywordClassification(thin)).admissionRequired).toBe(false);
  });

  it("routes away from a model with exhausted capacity", () => {
    const task = { objective: "refactor the duplicated authentication service", kind: "refactor" as const };
    const cls = keywordClassification(task);
    const small = { ...cheap, capabilityScore: 0.2 };
    const lunaStrong = subscription("codex-luna", "mid", 0.3, 0.6);
    // Rung floors moved up with the ladder: give the fixtures capability that
    // actually clears the moderate floor.
    const midCapable = { ...mid, capabilityScore: 0.62 };
    const withCapacity = route(task, [small, midCapable, lunaStrong], cls, {
      capacity: { "codex-luna": { available: false, reason: "rate limited" } },
    });
    expect(withCapacity.model?.id).toBe("balanced-mid");
    const plenty = route(task, [small, midCapable, lunaStrong], cls, {
      capacity: {
        "codex-luna": { available: true, usage: { remainingFraction: 0.95, windowElapsedFraction: 0.05, source: "t" } },
      },
    });
    expect(plenty.model?.id).toBe("codex-luna");
  });

  it("prefers a measured model over an unmeasured one at the same price", () => {
    const measured = { ...api("measured-mid", "mid", 0.02, 0.1), capabilityScore: 0.6 };
    const mystery = api("mystery-mid", "mid", 0.02, 0.1);
    const task = { objective: "rename a variable", kind: "code-change" as const };
    const d = route(task, [measured, mystery], keywordClassification(task));
    expect(d.model?.id).toBe("measured-mid");
  });

  it("treats a measured zero success rate as evidence", () => {
    const task = { objective: "debug the worker", kind: "debug" as const, failureCostUsd: 10 };
    const capable = { ...large, capabilityScore: 0.8 };
    const failed = scoreCandidate(
      task,
      task.kind,
      capable,
      undefined,
      { successRate: 0, rejectRate: 0 },
      defaultQuotaConfig,
    );
    expect(failed.pFail).toBeGreaterThan(0.9);
  });

  it("uses capability as the cold-start prior when history is absent", () => {
    const task = { objective: "debug the worker", kind: "debug" as const, failureCostUsd: 10 };
    const capable = { ...large, capabilityScore: 0.8 };
    const withoutSignal = scoreCandidate(task, task.kind, capable, undefined, undefined, defaultQuotaConfig);
    const benchmarkOnly = scoreCandidate(
      task,
      task.kind,
      capable,
      undefined,
      { evalScore: 0.8 },
      defaultQuotaConfig,
    );
    expect(benchmarkOnly.pFail).toBeCloseTo(withoutSignal.pFail);
    expect(benchmarkOnly.pFail).toBeLessThan(0.5);
  });

  it("prefers paid-for capacity on complex work but not on trivial work", () => {
    const cash = { ...api("cash-large", "large", 0.15, 0.75), capabilityScore: 0.72 };
    const sub = subscription("codex-sol", "large", 0.5, 0.774);
  const lunaStrong = subscription("codex-luna", "mid", 0.3, 0.6);
    const complex = {
      objective: "rewrite the billing service from scratch as a scalable event-driven system",
      complexity: "complex" as const,
      risk: "high" as const,
    };
    const trivial = { objective: "rename a variable", complexity: "trivial" as const };
    expect(route(complex, [cash, sub], keywordClassification(complex)).model?.id).toBe("codex-sol");
    // Quota is precious when the task does not need it: frugal wins.
    expect(route(trivial, [cash, sub], keywordClassification(trivial)).model?.id).toBe("cash-large");
  });

  it("breaks ties on measured capability, never on catalog order", () => {
    // Same price, same context, different benchmark: the better one must win,
    // and it must win regardless of the order they arrive in.
    const weaker = { ...api("gemini-3.7-flash", "mid", 0.75, 3.75), capabilityScore: 0.761 };
    const stronger = { ...api("gemini-3.8-flash", "mid", 0.75, 3.75), capabilityScore: 0.763 };
    const task = {
      objective: "implement pagination, filtering and sorting for the orders API",
      complexity: "advanced" as const,
    };
    const cls = keywordClassification(task);
    expect(route(task, [weaker, stronger], cls).model?.id).toBe("gemini-3.8-flash");
    expect(route(task, [stronger, weaker], cls).model?.id).toBe("gemini-3.8-flash");
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

  it("rejects explicitly non-text models without rejecting unknown modality", () => {
    const task = { objective: "summarize the notes", kind: "summarize" as const };
    const decisionOnly = {
      ...mid,
      id: "~typesafe/jev-latest",
      capabilities: { ...mid.capabilities, textOutput: false },
    } as ModelCapabilities;
    const unknownModality = { ...mid, id: "legacy/unknown-output" };

    const result = filterCandidates(
      task,
      "summarize",
      "simple",
      [decisionOnly, unknownModality],
      {},
    );

    expect(result.survivors.map((model) => model.id)).toEqual(["legacy/unknown-output"]);
    expect(result.pruned).toMatchObject([
      { model: { id: "~typesafe/jev-latest" }, reason: "no text output" },
    ]);
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
    const out = await c.classify({ objective: "deploy" });
    expect(keywordClassification({ objective: "deploy" }).score).toBe(uncertain.score);
    expect(out.degraded).toBe(true);
    expect(out.complexity).toBe("moderate");
  });

  it("costs the classification prompt, not the whole task context", () => {
    const cheapModel = api("cheap-classifier", "small", 0.02, 0.08);
    const small = classificationCost(cheapModel, { objective: "rename a variable" });
    const huge = classificationCost(cheapModel, {
      objective: "rename a variable",
      contextTokens: 200_000,
    });
    // A 200k-token context must not change what the classifier call costs.
    expect(huge).toBeCloseTo(small);
    // A short classification prompt, not a task with repository context.
    expect(small).toBeLessThan(0.00005);
  });

  it("uses the model answer and caches it", async () => {
    const complete = vi.fn(async () => ({ text: '{"complexity":"complex","confidence":0.93}' }));
    const c = new ModelClassifier({ models: [...models, mid, large], complete });
    // Score 1: uncertain, so the model is actually asked.
    const task = { objective: "deploy" };
    const first = await c.classify(task);
    const second = await c.classify(task);
    expect(first.complexity).toBe("complex");
    expect(first.source).toBe("model");
    expect(complete).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });

  it("includes project context and isolates cached answers per codebase", async () => {
    const complete = vi
      .fn()
      .mockResolvedValueOnce({ text: '{"complexity":"simple"}' })
      .mockResolvedValueOnce({ text: '{"complexity":"complex"}' });
    const c = new ModelClassifier({ models: [...models, mid, large], complete });
    const small = { objective: "fix authentication", projectContext: "Small app, one auth file" };
    const distributed = {
      objective: "fix authentication",
      projectContext: "Monorepo, custom OAuth and RBAC across eight services",
    };

    expect(classifierInput(small)).toContain("PROJECT CONTEXT");
    expect(classifierInput(small)).toContain("CURRENT TASK:\nfix authentication");
    expect((await c.classify(small)).complexity).toBe("simple");
    expect((await c.classify(distributed)).complexity).toBe("complex");
    expect(complete).toHaveBeenCalledTimes(2);
  });
});
