import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  classifierEvalCacheKey,
  classifierEvalCachedModelId,
  parseClassifierEvalArgs,
  summarizeClassifierResults,
} from "./classifier-eval-lib.js";

describe("classifier evaluation arguments", () => {
  it.each([
    [
      ["--backend", "keyword", "--heldout"],
      { backend: "keyword", heldout: true, live: false },
    ],
    [
      ["--backend", "chat", "--heldout", "--live"],
      { backend: "chat", heldout: true, live: true },
    ],
    [
      ["--backend", "jev", "--heldout", "--live"],
      { backend: "jev", heldout: true, live: true },
    ],
  ] as const)("parses %j", (args, expected) => {
    expect(parseClassifierEvalArgs([...args])).toMatchObject(expected);
  });

  it("defaults to cached chat offline and Jev for live evaluation", () => {
    expect(parseClassifierEvalArgs([]).backend).toBe("chat");
    expect(parseClassifierEvalArgs(["--live"]).backend).toBe("jev");
  });

  it("rejects an unknown backend", () => {
    expect(() => parseClassifierEvalArgs(["--backend", "other"])).toThrow(
      "--backend must be one of: jev, chat, keyword",
    );
  });
});

describe("classifier evaluation records", () => {
  it("namespaces cache entries by schema, backend, model, and input", () => {
    expect(classifierEvalCacheKey("jev", "~typesafe/jev-latest", "same input"))
      .not.toBe(classifierEvalCacheKey("chat", "~typesafe/jev-latest", "same input"));
  });

  it("recovers the chat model from a namespaced cache for offline replay", () => {
    const key = classifierEvalCacheKey(
      "chat",
      "provider/recorded-classifier",
      "cached prompt",
    );

    expect(
      classifierEvalCachedModelId(
        {
          "provider/legacy-classifier|old prompt": "old response",
          [key]: "cached response",
        },
        "chat",
      ),
    ).toBe("provider/recorded-classifier");
  });

  it("reports accuracy, underclassification, fallback, latency, and cost", () => {
    const summary = summarizeClassifierResults([
      {
        expectedKind: "debug",
        expectedComplexity: "complex",
        actualKind: "debug",
        actualComplexity: "complex",
        fallback: false,
        latencyMs: 100,
        costUsd: 0.00002,
      },
      {
        expectedKind: "review",
        expectedComplexity: "advanced",
        actualKind: "code-change",
        actualComplexity: "moderate",
        fallback: true,
        latencyMs: 300,
        costUsd: 0.00004,
      },
    ]);

    expect(summary).toMatchObject({
      samples: 2,
      kindAccuracy: 0.5,
      complexityAccuracy: 0.5,
      bothAccuracy: 0.5,
      underclassifications: 1,
      fallbacks: 1,
      fallbackRate: 0.5,
      meanLatencyMs: 200,
      p95LatencyMs: 300,
    });
    expect(summary.totalCostUsd).toBeCloseTo(0.00006);
    expect(summary.meanCostUsd).toBeCloseTo(0.00003);
  });

  it("keeps the held-out corpus balanced and fully explained", () => {
    const corpus = JSON.parse(
      readFileSync(join(process.cwd(), "eval", "corpus-heldout.json"), "utf8"),
    ) as {
      scenarios: Array<{
        task: { objective: string };
        expect: { kind?: string; complexity?: string; rationale?: string };
      }>;
    };
    const counts = corpus.scenarios.reduce<Record<string, number>>((result, scenario) => {
      const key = scenario.expect.complexity ?? "missing";
      result[key] = (result[key] ?? 0) + 1;
      return result;
    }, {});

    expect(corpus.scenarios).toHaveLength(24);
    expect(counts).toEqual({
      trivial: 4,
      simple: 4,
      moderate: 4,
      advanced: 4,
      complex: 4,
      frontier: 4,
    });
    expect(
      corpus.scenarios.every(
        (scenario) =>
          scenario.task.objective.length > 0 &&
          scenario.expect.kind &&
          scenario.expect.rationale,
      ),
    ).toBe(true);
  });
});
