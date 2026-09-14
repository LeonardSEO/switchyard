import type {
  CapacityState,
  Complexity,
  ModelCapabilities,
  RoutingSignal,
  TaskKind,
  TaskSpec,
} from "./types.js";
import { tierMeetsComplexity } from "./complexity.js";
import { capacityBlocked, defaultQuotaConfig, effectiveInputPer1M, type QuotaConfig } from "./quota.js";
import { estimateCostUsd, MIN_CAPABILITY_BY_COMPLEXITY } from "./scorer.js";

/** Default reserve: keep the last 10% of a quota window. */
export const DEFAULT_MIN_QUOTA_FRACTION = 0.1;

export interface PrunedCandidate {
  model: ModelCapabilities;
  reason: string;
}

export interface FilterContext {
  capacity?: Record<string, CapacityState>;
  signals?: Record<string, RoutingSignal>;
  quota?: QuotaConfig;
  nowMs?: number;
  /**
   * Reserve: below this fraction of remaining quota, subscription capacity is
   * held back. It cannot be refilled within the window, so running it to zero
   * on a routine task costs you the option of using it when it matters.
   */
  minQuotaFraction?: number;
  /**
   * Ignore models cheaper than this, USD per 1M input tokens. A rung can use it
   * to say "this class of work does not go to the cheapest thing that measures
   * well" when you distrust the benchmark at the cheap end.
   */
  minPricePer1M?: number;
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
  // Batch endpoints answer hours later, not in the middle of a coding session.
  if (m.batchOnly && !task.allowBatch) return "async batch endpoint";

  const priceFloor = ctx.minPricePer1M ?? 0;
  if (priceFloor > 0 && m.pricing.inputPer1M.known && m.pricing.inputPer1M.value < priceFloor) {
    return `below price floor $${priceFloor}/M`;
  }

  const usage = ctx.capacity?.[m.id];
  if (
    usage?.available === true &&
    usage.usage &&
    usage.usage.remainingFraction < (ctx.minQuotaFraction ?? DEFAULT_MIN_QUOTA_FRACTION)
  ) {
    return `quota reserve (${Math.round(usage.usage.remainingFraction * 100)}% left)`;
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

  // Capability floor, but only for models that publish one. Unmeasured models
  // are already gated by tier; refusing them here would silently delete every
  // model we have no benchmark for.
  const floor = MIN_CAPABILITY_BY_COMPLEXITY[complexity] ?? 0;
  if (floor > 0 && m.capabilityScore !== undefined && m.capabilityScore < floor) {
    return `capability ${m.capabilityScore.toFixed(2)} below floor ${floor} for ${complexity}`;
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
