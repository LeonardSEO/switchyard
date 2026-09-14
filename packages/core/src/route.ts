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
}

export function route(
  task: TaskSpec,
  models: ModelCapabilities[],
  classification: Classification,
  opts: RouteOptions = {},
): RouteDecision {
  const cfg: QuotaConfig = opts.quota ?? defaultQuotaConfig;
  const weights: Weights = { ...defaultWeights, ...opts.weights };
  const { kind, complexity } = classification;

  const { survivors, pruned } = filterCandidates(task, kind, complexity, models, opts);

  const ranked: RankedCandidate[] = survivors
    .map((m) => {
      // Per-kind history wins over global history: a model that fails at
      // debugging can still be the best choice for summarising.
      const signal =
        (opts.signals?.[`${m.id}|${kind}`] ?? opts.signals?.[m.id]) as
          | RoutingSignal
          | undefined;
      const s = scoreCandidate(
        task,
        kind,
        m,
        opts.capacity?.[m.id],
        signal,
        cfg,
        weights,
      );
      return {
        model: m,
        score: s.score,
        costFit: s.costFit,
        kindMatch: s.kindMatch,
        estCostUsd: s.estCostUsd,
      };
    })
    .sort((a, b) => b.score - a.score);

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
