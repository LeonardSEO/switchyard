import type {
  Complexity,
  Known,
  ModelCapabilities,
  ReasoningEffort,
  RoutingSignal,
  TaskKind,
  TaskSpec,
} from "./types";
import type { Classification } from "./classifier";
import { filterCandidates, type FilterContext, type PrunedCandidate } from "./filter";
import {
  defaultWeights,
  DEMAND_BY_COMPLEXITY,
  OVERQUALIFICATION_BAND,
  effortForComplexity,
  scoreCandidate,
  type Weights,
} from "./scorer";
import { defaultQuotaConfig, type QuotaConfig } from "./quota";

export interface RankedCandidate {
  model: ModelCapabilities;
  score: number;
  costFit: number;
  kindMatch: number;
  estCostUsd: Known<number>;
  pFail: number;
  expectedCostUsd: Known<number>;
  qualityScore: number;
  reliability: number;
}

export interface RouteDecision {
  /** null when nothing survives: callers must escalate or fail closed. */
  model: ModelCapabilities | null;
  kind: TaskKind;
  complexity: Complexity;
  classification: Classification;
  ranked: RankedCandidate[];
  pruned: PrunedCandidate[];
  effort: ReasoningEffort;
  /** True when the routing margin is thin: ask the candidate to self-admit. */
  admissionRequired: boolean;
  /** True when already-paid subscription capacity was preferred over cash. */
  paidCapacityPreferred: boolean;
  reason: string;
}

export interface RouteOptions extends FilterContext {
  weights?: Partial<Weights>;
  /** Score gap below which admission is required. */
  admissionMargin?: number;
  /**
   * Prefer already-paid subscription capacity while it is within this factor of
   * the best cash candidate. 0 disables the preference.
   */
  preferPaidCapacityFactor?: number;
  /**
   * Cost of one failed attempt, by task risk. Only used when the task does not
   * declare `failureCostUsd` itself. Set any entry to 0 to go back to
   * cheapest-viable-first for that risk level.
   */
  failureCostByRisk?: Partial<Record<"low" | "medium" | "high", number>>;
}

/**
 * A failed trivial task costs a retry. A failed rewrite costs the afternoon.
 * Without this the cheapest model always wins, which is only right when failure
 * is free — and for a rewrite it is not.
 */
/**
 * How much worse in expected cost already-paid capacity may be and still win.
 * 2 means: subscription capacity is preferred while it is within 2x of the best
 * cash option; beyond that, pay.
 */
export const DEFAULT_PREFER_PAID_CAPACITY_FACTOR = 2;

export const DEFAULT_FAILURE_COST_BY_RISK: Record<string, number> = {
  low: 1,
  medium: 5,
  high: 25,
};

export function route(
  task: TaskSpec,
  models: ModelCapabilities[],
  classification: Classification,
  opts: RouteOptions = {},
): RouteDecision {
  const cfg: QuotaConfig = opts.quota ?? defaultQuotaConfig;
  const weights: Weights = { ...defaultWeights, ...opts.weights };
  const { kind, complexity } = classification;

  const failureCost =
    task.failureCostUsd ??
    (opts.failureCostByRisk ?? DEFAULT_FAILURE_COST_BY_RISK)[task.risk ?? "low"] ??
    DEFAULT_FAILURE_COST_BY_RISK.low;
  const priced: TaskSpec = { ...task, failureCostUsd: failureCost };

  const { survivors, pruned } = filterCandidates(priced, kind, complexity, models, opts);

  const ranked: RankedCandidate[] = survivors
    .map((m) => {
      // Per-kind history wins over global history: a model that fails at
      // debugging can still be the best choice for summarising.
      const signal =
        (opts.signals?.[`${m.id}|${kind}`] ?? opts.signals?.[m.id]) as
          | RoutingSignal
          | undefined;
      const s = scoreCandidate(
        priced,
        kind,
        m,
        opts.capacity?.[m.id],
        signal,
        cfg,
        weights,
        DEMAND_BY_COMPLEXITY[complexity] ?? DEMAND_BY_COMPLEXITY.moderate,
      );
      return {
        model: m,
        score: s.score,
        costFit: s.costFit,
        kindMatch: s.kindMatch,
        estCostUsd: s.estCostUsd,
        pFail: s.pFail,
        expectedCostUsd: s.expectedCostUsd,
        qualityScore: s.qualityScore,
        reliability: s.reliability,
      };
    })
    .sort((a, b) => b.score - a.score);

  // Frontier band. When a task demands more than almost anything can do, the
  // few models that come close are within benchmark noise of each other. Credit
  // them equally and let price decide: that is the Pareto answer, and it stops
  // a 0.05 capability gap from justifying a 5x price gap.
  const capabilities = ranked
    .map((r) => r.model.capabilityScore)
    .filter((c): c is number => c !== undefined);
  if (capabilities.length > 1) {
    const maxCapability = Math.max(...capabilities);
    const demand = DEMAND_BY_COMPLEXITY[complexity] ?? DEMAND_BY_COMPLEXITY.moderate;
    if (demand >= maxCapability - OVERQUALIFICATION_BAND) {
      const band = maxCapability - OVERQUALIFICATION_BAND;
      for (const r of ranked) {
        const rescored = scoreCandidate(
          priced,
          kind,
          r.model,
          opts.capacity?.[r.model.id],
          opts.signals?.[`${r.model.id}|${kind}`] ?? opts.signals?.[r.model.id],
          cfg,
          weights,
          demand,
          band,
        );
        Object.assign(r, {
          score: rescored.score,
          costFit: rescored.costFit,
          pFail: rescored.pFail,
          expectedCostUsd: rescored.expectedCostUsd,
          qualityScore: rescored.qualityScore,
          reliability: rescored.reliability,
        });
      }
      ranked.sort((a, b) => b.score - a.score);
    }
  }

  // Relative expected cost. An absolute fit normalised against the failure cost
  // compresses every candidate to ~0.99 once failure is cheap, which quietly
  // hands the decision to raw capability and always picks the frontier model.
  // Expressing cost as a ratio to the best candidate keeps the axis meaningful
  // at every scale: twice the expected cost halves the cost term.
  const expectedCosts = ranked
    .map((r) => r.expectedCostUsd)
    .filter((e): e is { known: true; value: number } => e.known && e.value >= 0)
    .map((e) => e.value);
  if (failureCost > 0 && expectedCosts.length > 1) {
    const best = Math.min(...expectedCosts);
    for (const r of ranked) {
      const e = r.expectedCostUsd;
      if (!e.known) continue;
      const relative = e.value <= 0 ? 1 : Math.min(1, best / e.value);
      const previous = r.costFit;
      r.costFit = relative;
      r.score = (r.qualityScore - previous * weights.cost + relative * weights.cost) * r.reliability;
    }
    ranked.sort((a, b) => b.score - a.score);
  }

// Prefer capacity you already paid for — but only where that is justified.
// On a trivial task every capable model is equally likely to succeed, so
// expected costs are nearly identical and any preference would decide
// everything: there, being frugal with quota is the whole point. On complex and
// frontier work the subscription is the right call while it lasts.
const earnedCapacityIsWorthSpending = complexity === "complex" || complexity === "frontier";
const topBeforePreference = ranked[0]?.model ?? null;
if (
  earnedCapacityIsWorthSpending &&
  topBeforePreference &&
  topBeforePreference.pricing.kind !== "subscription" &&
  (opts.preferPaidCapacityFactor ?? DEFAULT_PREFER_PAID_CAPACITY_FACTOR) > 0 &&
  expectedCosts.length > 0
) {
  const factor = opts.preferPaidCapacityFactor ?? DEFAULT_PREFER_PAID_CAPACITY_FACTOR;
  const best = Math.min(...expectedCosts);
  const index = ranked.findIndex(
    (r) =>
      r.model.pricing.kind === "subscription" &&
      r.expectedCostUsd.known &&
      r.expectedCostUsd.value <= best * factor,
  );
  if (index > 0) {
    const [preferred] = ranked.splice(index, 1);
    ranked.unshift(preferred);
  }
}

  const top = ranked[0]?.model ?? null;
  const margin =
    ranked.length > 1 ? ranked[0].score - ranked[1].score : Number.POSITIVE_INFINITY;
  const admissionRequired =
    top !== null &&
    (complexity === "complex" ||
      task.risk === "high" ||
      margin < (opts.admissionMargin ?? 0.08));

  return {
    model: top,
    kind,
    complexity,
    classification,
    ranked,
    pruned,
    effort: effortForComplexity(complexity, task.risk),
    admissionRequired,
    paidCapacityPreferred:
      topBeforePreference !== null &&
      top !== null &&
      top.id !== topBeforePreference.id &&
      top.pricing.kind === "subscription",
    reason: explain(task, complexity, top, ranked, pruned, admissionRequired, margin),
  };
}

function explain(
  task: TaskSpec,
  complexity: Complexity,
  top: ModelCapabilities | null,
  ranked: RankedCandidate[],
  pruned: PrunedCandidate[],
  admissionRequired: boolean,
  margin: number,
): string {
  if (!top) {
    return `no viable candidate for a ${complexity} ${task.kind ?? "task"}: ${pruned.length} pruned (${pruned
      .map((p) => `${p.model.id}: ${p.reason}`)
      .join("; ")})`;
  }
  const parts = [
    `${complexity} task`,
    `picked ${top.id} (score ${ranked[0].score.toFixed(3)}, costFit ${ranked[0].costFit.toFixed(3)})`,
    `${pruned.length} pruned`,
  ];
  if (Number.isFinite(margin)) parts.push(`margin ${margin.toFixed(3)}`);
  if (admissionRequired) parts.push("admission required");
  return parts.join(", ");
}
