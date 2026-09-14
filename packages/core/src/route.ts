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
  reason: string;
}

export interface RouteOptions extends FilterContext {
  weights?: Partial<Weights>;
  /** Score gap below which admission is required. */
  admissionMargin?: number;
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
