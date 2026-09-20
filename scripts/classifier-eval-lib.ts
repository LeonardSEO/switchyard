import type { Complexity, TaskKind } from "@vepando/switchyard-core";

export type ClassifierEvalBackend = "jev" | "chat" | "keyword";

export interface ClassifierEvalOptions {
  backend: ClassifierEvalBackend;
  heldout: boolean;
  live: boolean;
  forceAll: boolean;
}

export const CLASSIFIER_EVAL_SCHEMA_VERSION = 2;

export function parseClassifierEvalArgs(args: string[]): ClassifierEvalOptions {
  const live = args.includes("--live");
  const backendIndex = args.indexOf("--backend");
  const value = backendIndex >= 0 ? args[backendIndex + 1] : undefined;
  if (backendIndex >= 0 && !isBackend(value)) {
    throw new Error("--backend must be one of: jev, chat, keyword");
  }
  return {
    backend: isBackend(value) ? value : live ? "jev" : "chat",
    heldout: args.includes("--heldout"),
    live,
    forceAll: args.includes("--always"),
  };
}

export function classifierEvalCacheKey(
  backend: ClassifierEvalBackend,
  model: string,
  input: string,
): string {
  return JSON.stringify({
    schema: CLASSIFIER_EVAL_SCHEMA_VERSION,
    backend,
    model,
    input,
  });
}

export interface ClassifierEvalResult {
  expectedKind: TaskKind;
  expectedComplexity: Complexity;
  actualKind: TaskKind;
  actualComplexity: Complexity;
  fallback: boolean;
  latencyMs: number;
  costUsd?: number;
}

export interface ClassifierEvalSummary {
  samples: number;
  kindAccuracy: number;
  complexityAccuracy: number;
  bothAccuracy: number;
  underclassifications: number;
  fallbacks: number;
  fallbackRate: number;
  meanLatencyMs: number;
  p95LatencyMs: number;
  totalCostUsd?: number;
  meanCostUsd?: number;
}

const COMPLEXITY_RANK: Record<Complexity, number> = {
  trivial: 0,
  simple: 1,
  moderate: 2,
  advanced: 3,
  complex: 4,
  frontier: 5,
};

export function summarizeClassifierResults(
  results: ClassifierEvalResult[],
): ClassifierEvalSummary {
  const samples = results.length;
  const divisor = samples || 1;
  const kindHits = results.filter((result) => result.actualKind === result.expectedKind).length;
  const complexityHits = results.filter(
    (result) => result.actualComplexity === result.expectedComplexity,
  ).length;
  const bothHits = results.filter(
    (result) =>
      result.actualKind === result.expectedKind &&
      result.actualComplexity === result.expectedComplexity,
  ).length;
  const underclassifications = results.filter(
    (result) =>
      COMPLEXITY_RANK[result.actualComplexity] <
      COMPLEXITY_RANK[result.expectedComplexity],
  ).length;
  const fallbacks = results.filter((result) => result.fallback).length;
  const latencies = results.map((result) => result.latencyMs).sort((a, b) => a - b);
  const p95Index = Math.max(0, Math.ceil(latencies.length * 0.95) - 1);
  const costs = results
    .map((result) => result.costUsd)
    .filter((cost): cost is number => cost !== undefined);
  const totalCostUsd = costs.reduce((total, cost) => total + cost, 0);

  return {
    samples,
    kindAccuracy: kindHits / divisor,
    complexityAccuracy: complexityHits / divisor,
    bothAccuracy: bothHits / divisor,
    underclassifications,
    fallbacks,
    fallbackRate: fallbacks / divisor,
    meanLatencyMs:
      results.reduce((total, result) => total + result.latencyMs, 0) / divisor,
    p95LatencyMs: latencies[p95Index] ?? 0,
    ...(costs.length > 0
      ? { totalCostUsd, meanCostUsd: totalCostUsd / costs.length }
      : {}),
  };
}

function isBackend(value: string | undefined): value is ClassifierEvalBackend {
  return value === "jev" || value === "chat" || value === "keyword";
}
