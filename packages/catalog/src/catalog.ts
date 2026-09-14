import type {
  CapacityState,
  ModelCapabilities,
  RoutingSignal,
  TaskKind,
} from "@vepando/switchyard-core";
import type { ModelSource, SourceResult } from "@vepando/switchyard-provider-openrouter";
import { CodexSubscriptionSource } from "./codex-subscription.js";

export interface SourceStatus {
  source: string;
  count: number;
  stale: boolean;
  note?: string;
}

export interface CatalogSnapshot {
  models: ModelCapabilities[];
  capacity: Record<string, CapacityState>;
  status: SourceStatus[];
  fetchedAt: number;
}

/**
 * One candidate pool from every configured source.
 *
 * "All available models" means: every model the sources report, including the
 * ones we cannot price and the ones we cannot measure. A model with an unknown
 * price or unknown capability is still a candidate — it is priced at the
 * worst-case cost fit and filtered by what is actually known, not dropped.
 */
export class Catalog {
  constructor(
    private readonly sources: ModelSource[] = [],
    private readonly codex?: CodexSubscriptionSource,
  ) {}

  async refresh(force = false): Promise<CatalogSnapshot> {
    const results: SourceResult[] = [];
    for (const s of this.sources) {
      results.push(await s.list(force));
    }

    const byId = new Map<string, ModelCapabilities>();
    // Earlier sources win: subscription and local capacity are more specific
    // than a generic API listing.
    for (const r of results) {
      for (const m of r.models) {
        if (!byId.has(m.id)) byId.set(m.id, m);
      }
    }

    const capacity: Record<string, CapacityState> = {};
    if (this.codex) {
      const sub = this.codex.list();
      for (const m of sub.models) if (!byId.has(m.id)) byId.set(m.id, m);
      Object.assign(capacity, sub.capacity);
    }

    const models = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
    const status: SourceStatus[] = results.map((r) => ({
      source: r.source,
      count: r.models.length,
      stale: r.stale,
      note: r.note,
    }));
    if (this.codex) {
      status.push({
        source: this.codex.id,
        count: this.codex.list().models.length,
        stale: false,
        note: Object.values(capacity).some((c) => c.available === false)
          ? "login not detected"
          : "login detected; quota unknown",
      });
    }

    return { models, capacity, status, fetchedAt: Date.now() };
  }
}

export interface CatalogStats {
  total: number;
  bySource: Record<string, number>;
  byTier: Record<string, number>;
  withCapabilityScore: number;
  withKnownPrice: number;
  free: number;
  /** Cheapest model per tier by known input price. */
  cheapestPerTier: Record<string, { id: string; usdPer1M: number } | undefined>;
}

export function stats(models: ModelCapabilities[]): CatalogStats {
  const bySource: Record<string, number> = {};
  const byTier: Record<string, number> = {};
  let withCapabilityScore = 0;
  let withKnownPrice = 0;
  let free = 0;
  const cheapest: Record<string, { id: string; usdPer1M: number } | undefined> = {};

  for (const m of models) {
    bySource[m.provider] = (bySource[m.provider] ?? 0) + 1;
    byTier[m.tier] = (byTier[m.tier] ?? 0) + 1;
    const score = m.capabilityScore;
    if (typeof score === "number") withCapabilityScore += 1;
    if (m.pricing.inputPer1M.known) withKnownPrice += 1;
    if (m.freeTier) free += 1;
    if (m.pricing.inputPer1M.known) {
      const price = m.pricing.inputPer1M.value ?? 0;
      const current = cheapest[m.tier];
      if (!current || price < current.usdPer1M) cheapest[m.tier] = { id: m.id, usdPer1M: price };
    }
  }

  return {
    total: models.length,
    bySource,
    byTier,
    withCapabilityScore,
    withKnownPrice,
    free,
    cheapestPerTier: cheapest,
  };
}

/**
 * Cold-start quality prior. A published coding benchmark is not the same as
 * "this model succeeds at your tasks", but it beats having nothing, and it is
 * replaced by real outcomes as soon as they exist (per kind, in the router).
 */
export function signalsFromCatalog(models: ModelCapabilities[]): Record<string, RoutingSignal> {
  const signals: Record<string, RoutingSignal> = {};
  for (const m of models) {
    if (m.capabilityScore === undefined) continue;
    signals[m.id] = { successRate: 0, rejectRate: 0, evalScore: m.capabilityScore };
  }
  return signals;
}

export function eligibleFor(models: ModelCapabilities[], kind: TaskKind): ModelCapabilities[] {
  return models.filter((m) => !(m.weaknesses ?? []).includes(kind));
}
