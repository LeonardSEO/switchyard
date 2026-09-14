import type { CapacityState, Known, ModelCapabilities, ReasoningEffort, Risk, RoutingSignal, TaskKind, TaskSpec } from "./types";
import { known } from "./types";
import { effectiveInputPer1M, effectiveOutputPer1M, type QuotaConfig } from "./quota";

/** Opus-class input cost, used as the "expensive" reference point (veto's ref). */
export const REFERENCE_INPUT_PER_1M = 15;
/** Price at which a model is considered as cheap as it can usefully get. */
export const CHEAP_FLOOR_PER_1M = 0.01;

export interface Weights {
  cost: number;
  success: number;
  kind: number;
  reject: number;
  eval: number;
}

/** Ported from veto's scorer: cheapest-viable-first, quality as a tiebreaker. */
export const defaultWeights: Weights = {
  cost: 0.35,
  success: 0.25,
  kind: 0.2,
  reject: 0.1,
  eval: 0.1,
};

export function kindMatch(m: ModelCapabilities, kind: TaskKind): number {
  if (m.strengths?.includes(kind)) return 1;
  if (m.weaknesses?.includes(kind)) return 0;
  return 0.5;
}

/**
 * Token estimate. Historical averages win; otherwise fall back to veto's shape
 * (input dominated by prompt, output ~10% of input) with a floor.
 */
export function estimateTokens(
  task: TaskSpec,
  signal: RoutingSignal | undefined,
): { input: number; output: number } {
  const input = Math.max(
    500,
    signal?.avgInputTokens ?? Math.ceil(task.objective.length / 4) + (task.contextTokens ?? 1500),
  );
  const output = Math.max(100, signal?.avgOutputTokens ?? Math.round(input / 10));
  return { input, output };
}

export function estimateCostUsd(
  m: ModelCapabilities,
  task: TaskSpec,
  cap: CapacityState | undefined,
  signal: RoutingSignal | undefined,
  cfg: QuotaConfig,
): Known<number> {
  const { input, output } = estimateTokens(task, signal);
  const inPrice = effectiveInputPer1M(m, cap, cfg);
  const outPrice = effectiveOutputPer1M(m, cap, cfg);
  if (!inPrice.known || !outPrice.known) {
    return { known: false, reason: "price unknown" };
  }
  return known((input / 1_000_000) * inPrice.value + (output / 1_000_000) * outPrice.value);
}

export interface CostScale {
  reference: number;
  floor: number;
}

export const defaultCostScale: CostScale = {
  reference: REFERENCE_INPUT_PER_1M,
  floor: CHEAP_FLOOR_PER_1M,
};

/**
 * Cost-efficiency score in [0, 1]. Unknown price scores at the floor (0.05).
 *
 * Deliberate divergence from veto: veto compares price linearly against an
 * opus reference, so everything below ~$1/M scores ~0.99 and a 10x price
 * difference between two cheap models is invisible. Almost every interesting
 * model now sits below $1/M, so we score on a log scale — a 10x difference
 * moves the score equally at the cheap and the expensive end.
 */
export function costFit(
  inputPer1M: Known<number>,
  estCost: Known<number>,
  maxCostUsd?: number,
  scale: CostScale = defaultCostScale,
): number {
  if (!inputPer1M.known) return 0.05;
  if (maxCostUsd && maxCostUsd > 0) {
    if (!estCost.known || estCost.value >= maxCostUsd) return 0;
    return 1 - estCost.value / maxCostUsd;
  }
  const p = inputPer1M.value;
  if (p <= scale.floor) return 1;
  if (p >= scale.reference) return 0.05;
  return Math.log(scale.reference / p) / Math.log(scale.reference / scale.floor);
}

export interface ScoreBreakdown {
  score: number;
  costFit: number;
  kindMatch: number;
  reliability: number;
  estCostUsd: Known<number>;
}

export function scoreCandidate(
  task: TaskSpec,
  kind: TaskKind,
  m: ModelCapabilities,
  cap: CapacityState | undefined,
  signal: RoutingSignal | undefined,
  cfg: QuotaConfig,
  weights: Weights = defaultWeights,
): ScoreBreakdown {
  const inPrice = effectiveInputPer1M(m, cap, cfg);
  const estCost = estimateCostUsd(m, task, cap, signal, cfg);
  const fit = costFit(inPrice, estCost, task.maxCostUsd);
  const km = kindMatch(m, kind);
  const s = signal;
  const quality =
    km * weights.kind +
    (s?.successRate ?? 0) * weights.success +
    fit * weights.cost +
    (1 - (s?.rejectRate ?? 0)) * weights.reject +
    (s?.evalScore ?? 0) * weights.eval;
  // Expected retries are a cost too: a rate-limited free tier that fails twice
  // before succeeding is not cheaper than a reliable $0.06/M model.
  const reliability = m.reliability ?? 1;
  return {
    score: quality * reliability,
    costFit: fit,
    kindMatch: km,
    reliability,
    estCostUsd: estCost,
  };
}

const EFFORT_LADDER: ReasoningEffort[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export function effortForComplexity(complexity: string, risk: Risk | undefined): ReasoningEffort {
  const base: ReasoningEffort =
    complexity === "complex" ? "high" : complexity === "moderate" ? "medium" : "low";
  const bumped = risk === "high" ? EFFORT_LADDER[Math.min(EFFORT_LADDER.indexOf(base) + 1, EFFORT_LADDER.length - 1)] : base;
  return bumped;
}
