import type {
  CapacityState,
  Complexity,
  ModelCapabilities,
  RoutingSignal,
  TaskKind,
  TaskSpec,
} from "./types";
import { tierMeetsComplexity } from "./complexity";
import { capacityBlocked, defaultQuotaConfig, effectiveInputPer1M, type QuotaConfig } from "./quota";
import { estimateCostUsd } from "./scorer";

export interface PrunedCandidate {
  model: ModelCapabilities;
  reason: string;
}

export interface FilterContext {
  capacity?: Record<string, CapacityState>;
  signals?: Record<string, RoutingSignal>;
  quota?: QuotaConfig;
  nowMs?: number;
}

/**
 * Hard filter. Veto's checks plus capacity; anything unknown is treated
 * conservatively: unknown tool support does not prune, unknown context does
 * not prune, unknown cost prunes only when a ceiling is set.
 */
export function filterCandidates(
  task: TaskSpec,
  kind: TaskKind,
  complexity: Complexity,
  models: ModelCapabilities[],
  ctx: FilterContext = {},
): { survivors: ModelCapabilities[]; pruned: PrunedCandidate[] } {
  const cfg = ctx.quota ?? defaultQuotaConfig;
  const nowMs = ctx.nowMs ?? Date.now();
  const survivors: ModelCapabilities[] = [];
  const pruned: PrunedCandidate[] = [];

  for (const m of models) {
    const reason = rejectionReason(task, kind, complexity, m, ctx, cfg, nowMs);
    if (reason) pruned.push({ model: m, reason });
    else survivors.push(m);
  }
  return { survivors, pruned };
}

function rejectionReason(
  task: TaskSpec,
  kind: TaskKind,
  complexity: Complexity,
  m: ModelCapabilities,
  ctx: FilterContext,
  cfg: QuotaConfig,
  nowMs: number,
): string | undefined {
  if (task.skipModels?.includes(m.id)) return "already tried in this run";
  if (capacityBlocked(ctx.capacity?.[m.id], nowMs)) {
    return "capacity unavailable";
  }
  if (m.weaknesses?.includes(kind)) return `weakness: ${kind}`;

  const needed = task.contextTokens ?? 0;
  if (m.maxContextTokens !== undefined && needed > 0 && m.maxContextTokens < needed) {
    return `context ${m.maxContextTokens} < ${needed}`;
  }

  if (task.requiredTools?.length) {
    if (m.supportsTools !== undefined) {
      const missing = task.requiredTools.filter((t) => !m.supportsTools!.includes(t));
      if (missing.length) return `missing tools: ${missing.join(", ")}`;
    }
  }

  if (!tierMeetsComplexity(m.tier, complexity)) {
    return `tier ${m.tier} below complexity ${complexity}`;
  }

  if (task.maxCostUsd && task.maxCostUsd > 0) {
    const est = estimateCostUsd(m, task, ctx.capacity?.[m.id], ctx.signals?.[m.id], cfg);
    if (!est.known) return "cost unknown and a ceiling is set";
    if (est.value > task.maxCostUsd) return `est $${est.value.toFixed(5)} > ceiling`;
  }

  return undefined;
}

/** Surfaces the effective price used, for explainability in route decisions. */
export function priceFor(
  m: ModelCapabilities,
  cap: CapacityState | undefined,
  cfg: QuotaConfig = defaultQuotaConfig,
) {
  return effectiveInputPer1M(m, cap, cfg);
}
