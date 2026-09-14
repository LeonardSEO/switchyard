/**
 * Pareto reasoning over price and quality.
 *
 * No model ID is ever the answer. The answer is: among the models that are
 * available *now* and capable *enough*, the ones that are not dominated — no
 * other model is both cheaper and better. The router picks from that frontier;
 * everything else is noise, and the frontier changes weekly.
 *
 * Unknown values are never treated as favourable: an unknown price cannot
 * dominate a known one, and an unknown quality score cannot dominate a measured
 * one. Unknown is not free and unknown is not good.
 */

export interface ParetoAxes<T> {
  /** Lower is better. `undefined` = unknown. */
  price: (item: T) => number | undefined;
  /** Higher is better. `undefined` = unknown. */
  quality: (item: T) => number | undefined;
}

const PRICE_UNKNOWN = Number.POSITIVE_INFINITY;
const QUALITY_UNKNOWN = Number.NEGATIVE_INFINITY;

/** True when `a` is at least as good as `b` on both axes and strictly better on one. */
export function dominates<T>(a: T, b: T, axes: ParetoAxes<T>): boolean {
  const ap = axes.price(a) ?? PRICE_UNKNOWN;
  const bp = axes.price(b) ?? PRICE_UNKNOWN;
  const aq = axes.quality(a) ?? QUALITY_UNKNOWN;
  const bq = axes.quality(b) ?? QUALITY_UNKNOWN;

  const atLeastAsGood = ap <= bp && aq >= bq;
  const strictlyBetter = ap < bp || aq > bq;
  // An unknown axis can never be the reason something dominates.
  const noUnknownAdvantage =
    (axes.price(a) !== undefined || axes.price(b) === undefined) &&
    (axes.quality(a) !== undefined || axes.quality(b) === undefined);

  return atLeastAsGood && strictlyBetter && noUnknownAdvantage;
}

/** The non-dominated subset, ordered by price ascending. */
export function paretoFrontier<T>(items: T[], axes: ParetoAxes<T>): T[] {
  return items
    .filter((item) => !items.some((other) => other !== item && dominates(other, item, axes)))
    .sort((a, b) => (axes.price(a) ?? PRICE_UNKNOWN) - (axes.price(b) ?? PRICE_UNKNOWN));
}

export function isParetoOptimal<T>(item: T, items: T[], axes: ParetoAxes<T>): boolean {
  return !items.some((other) => other !== item && dominates(other, item, axes));
}

/**
 * Cheapest model that still clears a quality floor. This is the shape of the
 * routing decision: a floor set by the task, then the cheapest thing above it.
 */
export function cheapestAboveQuality<T>(
  items: T[],
  minQuality: number,
  axes: ParetoAxes<T>,
): T | undefined {
  const eligible = items.filter((i) => {
    const q = axes.quality(i);
    return q !== undefined && q >= minQuality;
  });
  if (eligible.length === 0) return undefined;
  return eligible.reduce((best, item) =>
    (axes.price(item) ?? PRICE_UNKNOWN) < (axes.price(best) ?? PRICE_UNKNOWN) ? item : best,
  );
}

/** Default axes for the model catalog: input price vs published capability. */
export function catalogAxes<T extends { pricing: { inputPer1M: { known: boolean; value?: number } }; capabilityScore?: number }>(
  priceOf?: (item: T) => number | undefined,
): ParetoAxes<T> {
  return {
    price: (item) =>
      priceOf
        ? priceOf(item)
        : item.pricing.inputPer1M.known
          ? item.pricing.inputPer1M.value
          : undefined,
    quality: (item) => item.capabilityScore,
  };
}
