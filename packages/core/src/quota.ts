import type { CapacityState, Known, ModelCapabilities, Usage } from "./types.js";
import { known, unknown } from "./types.js";

/**
 * Quota intelligence: the piece veto does not have.
 *
 * A subscription model has no per-token invoice, so its marginal cost is not
 * zero and not the API list price either. We model it as:
 *
 *   effective = planAmortized * (1 + scarcityWeight * scarcity(usage))
 *
 * where `scarcity` grows as remaining quota falls and as consumption runs ahead
 * of the window. Unknown usage never becomes "free": it falls back to a
 * conservative multiplier, and an unknown amortized price stays unknown so the
 * scorer can apply its worst-case cost fit.
 */

export interface QuotaConfig {
  /** How strongly scarcity raises the shadow price. 3 => up to 4x when drained. */
  scarcityWeight: number;
  /** USD per 1M tokens, used when a subscription model declares no amortized price. */
  defaultPlanAmortizedPer1M: number;
  /** Applied when usage is unknown but an amortized price is known. */
  unknownUsageMultiplier: number;
  /**
   * Share of the amortized price forgiven for quota that will probably expire
   * unused (remaining ahead of elapsed window). 1 => fully free at r=1,w=0.
   * Set to 0 to price every subscription token at full amortized cost.
   */
  expiringRelief: number;
}

export const defaultQuotaConfig: QuotaConfig = {
  scarcityWeight: 3,
  defaultPlanAmortizedPer1M: 0.3,
  unknownUsageMultiplier: 1.5,
  expiringRelief: 1,
};

export const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));
const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

/**
 * 0 = quota is abundant relative to the window, 1 = effectively exhausted.
 *
 * `pace` compares elapsed window to remaining quota: pace > 1 means the account
 * is burning faster than the window allows, which raises scarcity even when the
 * raw remaining fraction still looks comfortable.
 */
export function scarcity(usage: Usage): number {
  const remaining = clamp01(usage.remainingFraction);
  const elapsed = clamp01(usage.windowElapsedFraction);
  const pace = elapsed / Math.max(remaining, 0.01);
  return clamp01((1 - remaining) * (clamp(pace, 0.5, 2) / 2));
}

function subscriptionPrice(
  m: ModelCapabilities,
  cap: CapacityState | undefined,
  cfg: QuotaConfig,
): Known<number> {
  const base = m.pricing.planAmortizedPer1M ?? known(cfg.defaultPlanAmortizedPer1M);
  if (!base.known) return unknown("no amortized price for subscription capacity");

  if (!cap) return known(base.value * cfg.unknownUsageMultiplier);
  if (cap.available === false) return unknown(cap.reason);
  if (cap.available === "unknown" || !cap.usage) {
    return known(base.value * cfg.unknownUsageMultiplier);
  }
  // Quota that will not be spent before the reset displaces nothing: forgive a
  // share of the amortized price proportional to how likely it is to be wasted.
  const expiring = clamp01(cap.usage.remainingFraction - cap.usage.windowElapsedFraction);
  const relief = Math.max(0, 1 - expiring * cfg.expiringRelief);
  const multiplier = (1 + cfg.scarcityWeight * scarcity(cap.usage)) * relief;
  return known(base.value * multiplier);
}

export function effectiveInputPer1M(
  m: ModelCapabilities,
  cap: CapacityState | undefined,
  cfg: QuotaConfig = defaultQuotaConfig,
): Known<number> {
  if (cap?.available === false) return unknown(cap.reason);
  switch (m.pricing.kind) {
    case "local":
      return known(0);
    case "subscription":
      return subscriptionPrice(m, cap, cfg);
    default:
      return m.pricing.inputPer1M;
  }
}

export function effectiveOutputPer1M(
  m: ModelCapabilities,
  cap: CapacityState | undefined,
  cfg: QuotaConfig = defaultQuotaConfig,
): Known<number> {
  if (cap?.available === false) return unknown(cap.reason);
  switch (m.pricing.kind) {
    case "local":
      return known(0);
    case "subscription":
      return subscriptionPrice(m, cap, cfg);
    default:
      return m.pricing.outputPer1M;
  }
}

/** A known-false capacity blocks routing; "unknown" never blocks on its own. */
export function capacityBlocked(
  cap: CapacityState | undefined,
  nowMs: number,
): boolean {
  if (!cap || cap.available !== false) return false;
  if (cap.unavailableUntilMs === undefined) return true;
  return cap.unavailableUntilMs > nowMs;
}
