import type { CapacityState, Known, ModelCapabilities, ReasoningEffort, Risk, RoutingSignal, TaskKind, TaskSpec } from "./types.js";
import { known } from "./types.js";
import { effectiveInputPer1M, effectiveOutputPer1M, type QuotaConfig } from "./quota.js";

/** Opus-class input cost, used as the "expensive" reference point (veto's ref). */
export const REFERENCE_INPUT_PER_1M = 15;
/** Price at which a model is considered as cheap as it can usefully get. */
export const CHEAP_FLOOR_PER_1M = 0.01;

/**
 * How much capability a task demands, by inferred complexity. Failure is the
 * gap between what a task demands and what a model can do — not the model's
 * absolute score. A weak model is perfectly reliable at a trivial rename.
 */
/**
 * Each rung's demand sets a ceiling (demand + band) and that ceiling selects
 * the model class: whatever is cheapest at or above it. Calibrated so the rungs
 * land on recognisable classes in the live catalog:
 *
 *   trivial/simple  -> cheapest capable (measured, ~$0.02/M)
 *   moderate        -> flash class: deepseek v4 flash, glm 5.3 flash   (~$0.06)
 *   advanced        -> pro class: glm 5.3, kimi k3, deepseek v4 pro    (~$0.75)
 *   complex         -> top class: grok 4.6, gpt-5.6-sol, opus          (~$2)
 *   frontier        -> frontier band: best available, Codex Astra when it lasts
 */
export const DEMAND_BY_COMPLEXITY: Record<string, number> = {
  trivial: 0.15,
  simple: 0.6,
  moderate: 0.66,
  advanced: 0.69,
  complex: 0.72,
  frontier: 0.85,
};

/**
 * Capability a task must clear, beyond the coarse tier gate. Only applied to
 * models that publish a score: an unmeasured model is filtered by tier, not by
 * a number it cannot report.
 */
export const MIN_CAPABILITY_BY_COMPLEXITY: Record<string, number> = {
  trivial: 0,
  simple: 0.4,
  moderate: 0.55,
  advanced: 0.6,
  complex: 0.68,
  frontier: 0.7,
};

/**
 * Capability beyond what a task demands earns nothing. A 0.82 model is not
 * measurably better than a 0.77 model on a task that needs 0.65 — the gap is
 * within benchmark noise, and paying 5x for it is not a decision, it is
 * superstition. Capping it makes the frontier a band, and within that band the
 * cheapest model wins. That is what "Pareto-optimal frontier" means here.
 */
export const OVERQUALIFICATION_BAND = 0.05;

/** Assumed capability when nothing is published: mediocre, not average. */
export const UNMEASURED_CAPABILITY = 0.4;

/**
 * Risk premium on models with no published benchmark. Buy unknown quality only
 * when it is clearly cheaper: without this, a $0.002/M price gap — fifty
 * microdollars on a real task — decides between a measured model and one nobody
 * has scored.
 */
export const UNMEASURED_RISK_PREMIUM = 1.5;

export function effectiveCapability(capability: number, demand: number): number {
  return Math.min(capability, demand + OVERQUALIFICATION_BAND);
}

/**
 * Probability that an attempt fails, from the gap between demand and measured
 * capability. Unmeasured capability is treated as mediocre rather than average:
 * unknown is not neutral.
 */
export function failureProbability(
  quality: number | undefined,
  demand: number,
  temperature = 0.12,
): number {
  const q = quality ?? 0.4;
  return 1 / (1 + Math.exp(-(demand - q) / temperature));
}

/** Cost of one attempt, including the cost of it going wrong. */
export function expectedCostUsd(
  estCost: Known<number>,
  pFail: number,
  failureCostUsd: number,
): Known<number> {
  if (!estCost.known) return { known: false, reason: "cost unknown" };
  return known(estCost.value + pFail * failureCostUsd);
}

/**
 * Cost fit in absolute expected dollars: an attempt that costs twice as much as
 * a failure scores zero.
 *
 * Two properties matter here. It compares dollars, so $0.001 and $0.45 stay a
 * real difference rather than collapsing into a tie. And it scales with the
 * declared failure cost, so when failure is cheap, token price decides, and when
 * failure is expensive, the failure term decides.
 */
export function costFitExpected(
  expectedTotal: Known<number>,
  failureCostUsd: number,
): number {
  if (!expectedTotal.known) return 0.05;
  const reference = failureCostUsd * 2;
  if (reference <= 0) return 1;
  return Math.max(0.05, 1 - expectedTotal.value / reference);
}

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
 * Context a coding agent actually sends: system prompt, tool schemas, repo
 * context, session history. Calibrating this too low makes token cost look
 * irrelevant next to failure cost and sends every task to the frontier model.
 */
export const DEFAULT_CONTEXT_TOKENS = 24_000;

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
    signal?.avgInputTokens ??
      Math.ceil(task.objective.length / 4) + (task.contextTokens ?? DEFAULT_CONTEXT_TOKENS),
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

/** Multiply a known value, leave unknown untouched. */
function scale(value: Known<number>, factor: number): Known<number> {
  return value.known ? known(value.value * factor) : value;
}

export interface ScoreBreakdown {
  score: number;
  /** Weighted quality before the reliability multiplier, for re-scoring. */
  qualityScore: number;
  costFit: number;
  kindMatch: number;
  reliability: number;
  estCostUsd: Known<number>;
  /** Probability this attempt fails, from demand vs measured capability. */
  pFail: number;
  /** Effective input price used, for display and deterministic tie-breaks. */
  pricePer1M: Known<number>;
  /** Token cost plus expected failure cost, when a failure cost is declared. */
  expectedCostUsd: Known<number>;
}

/** Four equivalent benchmark observations keep tiny local samples from becoming absolutes. */
export const HISTORY_PRIOR_WEIGHT = 4;

export function smoothedSuccessRate(
  signal: RoutingSignal | undefined,
  prior: number | undefined,
): number | undefined {
  if (signal?.successRate === undefined) return prior;
  const sampleMass = signal.effectiveSampleSize ?? signal.sampleCount;
  // Preserve the public behavior of callers that supply a rate without the new
  // sample metadata. Only outcome-derived rates are automatically shrunk.
  if (sampleMass === undefined) return signal.successRate;
  const benchmark = prior ?? UNMEASURED_CAPABILITY;
  return (
    benchmark * HISTORY_PRIOR_WEIGHT + signal.successRate * Math.max(0, sampleMass)
  ) / (HISTORY_PRIOR_WEIGHT + Math.max(0, sampleMass));
}

export function scoreCandidate(
  task: TaskSpec,
  kind: TaskKind,
  m: ModelCapabilities,
  cap: CapacityState | undefined,
  signal: RoutingSignal | undefined,
  cfg: QuotaConfig,
  weights: Weights = defaultWeights,
  demand: number = DEMAND_BY_COMPLEXITY.moderate,
  /** Hard ceiling on credited capability, used for the frontier band. */
  qualityCap?: number,
): ScoreBreakdown {
  const premium = m.capabilityScore === undefined ? UNMEASURED_RISK_PREMIUM : 1;
  const inPrice = scale(effectiveInputPer1M(m, cap, cfg), premium);
  const estCost = scale(estimateCostUsd(m, task, cap, signal, cfg), premium);
  // History beats benchmarks, benchmarks beat nothing. Capability above what
  // the task demands is capped: it is noise, not value.
  const historicalSuccess =
    signal?.successRate === undefined ? undefined : smoothedSuccessRate(signal, m.capabilityScore);
  const raw = historicalSuccess ?? m.capabilityScore;
  const ceiling = Math.min(demand + OVERQUALIFICATION_BAND, qualityCap ?? Number.POSITIVE_INFINITY);
  // Unmeasured gets the assumed level and the same ceiling. Returning
  // "undefined" here would silently skip the ceiling and hand unmeasured models
  // a better score than measured ones on tasks that need almost nothing.
  const quality = Math.min(raw ?? UNMEASURED_CAPABILITY, ceiling);
  const pFail = failureProbability(quality, demand);
  const expected = expectedCostUsd(estCost, pFail, task.failureCostUsd ?? 0);
  const fit =
    task.failureCostUsd && task.failureCostUsd > 0
      ? costFitExpected(scale(expected, premium), task.failureCostUsd)
      : costFit(inPrice, estCost, task.maxCostUsd);
  const km = kindMatch(m, kind);
  const s = signal;
  // The eval term uses the same ceiling. Otherwise capping failure probability
  // but not quality silently hands the decision back to raw capability, and the
  // most capable model wins again through the back door.
  const evalScore = Math.min(
    s?.evalScore ?? m.capabilityScore ?? UNMEASURED_CAPABILITY,
    ceiling,
  );
  const qualityScore =
    km * weights.kind +
    (historicalSuccess ?? 0) * weights.success +
    fit * weights.cost +
    (1 - (s?.rejectRate ?? 0)) * weights.reject +
    evalScore * weights.eval;
  // Expected retries are a cost too: a rate-limited free tier that fails twice
  // before succeeding is not cheaper than a reliable $0.06/M model.
  const reliability = m.reliability ?? 1;
  return {
    score: qualityScore * reliability,
    qualityScore,
    costFit: fit,
    kindMatch: km,
    reliability,
    estCostUsd: estCost,
    pFail,
    pricePer1M: inPrice,
    expectedCostUsd:
      task.failureCostUsd && task.failureCostUsd > 0
        ? expectedCostUsd(estCost, pFail, task.failureCostUsd)
        : { known: false, reason: "no failure cost declared" },
  };
}

const EFFORT_LADDER: ReasoningEffort[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export function effortForComplexity(complexity: string, risk: Risk | undefined): ReasoningEffort {
  const base: ReasoningEffort =
    complexity === "frontier"
      ? "xhigh"
      : complexity === "complex"
        ? "high"
        : complexity === "advanced"
          ? "high"
          : complexity === "moderate"
            ? "medium"
            : complexity === "simple"
              ? "low"
              : "minimal";
  const bumped = risk === "high" ? EFFORT_LADDER[Math.min(EFFORT_LADDER.indexOf(base) + 1, EFFORT_LADDER.length - 1)] : base;
  return bumped;
}
