import type { Complexity, ModelCapabilities, TaskKind, TaskSpec } from "./types";
import { estimateTokens } from "./scorer";
import {
  estimateComplexity,
  inferComplexity,
  inferKind,
  tierMeetsComplexity,
} from "./complexity";

/**
 * Task classification.
 *
 * Default is deterministic and free (keyword scoring). A model-backed
 * classifier exists as an *escalation layer* only: classification costs about
 * three orders of magnitude less than one wrong routing decision, so the money
 * argument favours using it — latency, availability and privacy do not.
 *
 * Rules the router enforces around it:
 *   - never spend subscription quota on classification (opportunity cost);
 *   - only escalate when the deterministic answer is uncertain;
 *   - only escalate when the expected routing saving dwarfs the call cost;
 *   - cache by task fingerprint;
 *   - fall back to the deterministic answer on any failure.
 */

export interface Classification {
  kind: TaskKind;
  complexity: Complexity;
  /** 0..1. Deterministic classification is low-confidence by design. */
  confidence: number;
  source: "explicit" | "keyword" | "model";
  /** Keyword score, present for source "keyword". */
  score?: number;
  matched?: string[];
  /** True when a model classifier was attempted but failed. */
  degraded?: boolean;
  /** Cost of the classification call, USD, when a model was used. */
  costUsd?: number;
}

export interface Classifier {
  classify(task: TaskSpec): Promise<Classification>;
}

/** Distance from a complexity threshold at which the answer is ambiguous. */
export const UNCERTAINTY_BAND = 1;

/** Pure, synchronous keyword classification. No I/O, no cost, no network. */
export function keywordClassification(task: TaskSpec): Classification {
  const kind = task.kind ?? inferKind(task.objective);
  const est = estimateComplexity(task, kind);
  if (est.source === "explicit") {
    return { kind, complexity: est.complexity, confidence: 1, source: "explicit" };
  }
  const distanceToThreshold = Math.min(Math.abs(est.score - 1), Math.abs(est.score - 4));
  const confidence = Math.max(0.3, Math.min(0.85, 0.3 + distanceToThreshold * 0.15));
  return {
    kind,
    complexity: est.complexity,
    confidence,
    source: "keyword",
    score: est.score,
    matched: est.matched,
  };
}

export class KeywordClassifier implements Classifier {
  async classify(task: TaskSpec): Promise<Classification> {
    return keywordClassification(task);
  }
}

export function isUncertain(c: Classification): boolean {
  if (c.source !== "keyword" || c.score === undefined) return false;
  return (
    Math.abs(c.score - 1) < UNCERTAINTY_BAND || Math.abs(c.score - 4) < UNCERTAINTY_BAND
  );
}

export interface CompletionRequest {
  model: ModelCapabilities;
  system: string;
  user: string;
  maxOutputTokens: number;
}

export interface CompletionResult {
  text: string;
  costUsd?: number;
}

/** Injected by a provider package; core performs no I/O. */
export type CompletionFn = (req: CompletionRequest) => Promise<CompletionResult>;

export interface ClassifierFloors {
  minContextTokens: number;
  /** Reject models known to be too weak to follow a JSON schema. */
  minTier?: "small" | "mid" | "large";
  denylist?: string[];
  /** The classifier must return parseable JSON. */
  requireStructuredOutput?: boolean;
  /** A classifier that is rate-limited or answers hours later is no use. */
  allowFreeTier?: boolean;
  allowBatch?: boolean;
  /**
   * Require a published capability score. Default true: an unmeasured model is
   * a guess, and a router should not guess about the component that decides
   * every other decision.
   */
  requireBenchmark?: boolean;
  /** Minimum published capability (0..1) for the classifier. */
  minCapabilityScore?: number;
}

export const defaultClassifierFloors: ClassifierFloors = {
  minContextTokens: 16_000,
  requireStructuredOutput: true,
  allowFreeTier: false,
  allowBatch: false,
  requireBenchmark: true,
  minCapabilityScore: 0.2,
};

/**
 * Cheapest model that can actually do the job: follows a schema, answers now,
 * is not rate-limited to nothing. Recomputed from the live catalog — hardcoding
 * "use deepseek-v4-flash" is a maintenance trap, and picking the raw cheapest
 * row picks a `:free` or `:batch` endpoint that cannot serve a classification.
 */
export function pickCheapestClassifier(
  models: ModelCapabilities[],
  floors: ClassifierFloors = defaultClassifierFloors,
): ModelCapabilities | undefined {
  const tierRank = { small: 0, mid: 1, large: 2, unknown: -1 } as const;
  const minTier = floors.minTier ? tierRank[floors.minTier] : -1;
  let best: ModelCapabilities | undefined;
  let bestPrice = Infinity;
  for (const m of models) {
    if (m.pricing.kind !== "api") continue;
    if (!m.pricing.inputPer1M.known) continue;
    if ((m.maxContextTokens ?? 0) < floors.minContextTokens) continue;
    if (floors.denylist?.includes(m.id)) continue;
    if (!floors.allowFreeTier && m.freeTier) continue;
    if (!floors.allowBatch && m.batchOnly) continue;
    if (floors.requireStructuredOutput && m.capabilities?.structuredOutput !== true) continue;
    // Unmeasured means unknown, and unknown cannot be trusted with the
    // decision that gates every other decision.
    if (floors.requireBenchmark !== false) {
      if (m.capabilityScore === undefined) continue;
      if (m.capabilityScore < (floors.minCapabilityScore ?? 0)) continue;
    }
    if (tierRank[m.tier] < minTier) continue;
    const price = m.pricing.inputPer1M.known ? m.pricing.inputPer1M.value : Infinity;
    if (price < bestPrice) {
      best = m;
      bestPrice = price;
    }
  }
  return best;
}

export interface ModelClassifierOptions {
  models: ModelCapabilities[];
  complete: CompletionFn;
  fallback?: Classifier;
  floors?: ClassifierFloors;
  /** Hard cap on classification spend per task, USD. */
  maxCostUsd?: number;
  /** Required ratio of expected routing saving to classification cost. */
  minSavingsFactor?: number;
  cache?: ClassificationCache;
  /** Overrides automatic cheapest-model selection. */
  modelId?: string;
}

const CLASSIFIER_SYSTEM = `You classify a coding task for a model router.
Reply with JSON only: {"kind":<debug|refactor|summarize|extract|review|plan|code-change>,"complexity":<simple|moderate|complex>,"confidence":<0..1>}
simple = mechanical, local, one file. moderate = multi-file feature or contained bug. complex = architecture, distributed systems, migration, ambiguous requirements.`;

export class ClassificationCache {
  private map = new Map<string, Classification>();
  constructor(private readonly maxEntries = 500) {}

  static key(task: TaskSpec): string {
    return `${task.kind ?? ""}|${task.objective.trim().toLowerCase().replace(/\s+/g, " ")}`;
  }

  get(task: TaskSpec): Classification | undefined {
    return this.map.get(ClassificationCache.key(task));
  }

  set(task: TaskSpec, value: Classification): void {
    if (this.map.size >= this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(ClassificationCache.key(task), value);
  }
}

export class ModelClassifier implements Classifier {
  private readonly fallback: Classifier;
  private readonly floors: ClassifierFloors;
  private readonly cache: ClassificationCache;
  private readonly maxCostUsd: number;
  private readonly minSavingsFactor: number;

  constructor(private readonly opts: ModelClassifierOptions) {
    this.fallback = opts.fallback ?? new KeywordClassifier();
    this.floors = opts.floors ?? defaultClassifierFloors;
    this.cache = opts.cache ?? new ClassificationCache();
    this.maxCostUsd = opts.maxCostUsd ?? 0.001;
    this.minSavingsFactor = opts.minSavingsFactor ?? 25;
  }

  async classify(task: TaskSpec): Promise<Classification> {
    const base = await this.fallback.classify(task);
    const cached = this.cache.get(task);
    if (cached) return cached;

    if (!isUncertain(base)) return base;

    const model =
      this.opts.models.find((m) => m.id === this.opts.modelId) ??
      pickCheapestClassifier(this.opts.models, this.floors);
    if (!model) return base;

    const est = estimateTokens(task, undefined);
    const approxCost =
      ((est.input / 1_000_000) * (model.pricing.inputPer1M.known ? model.pricing.inputPer1M.value : 0)) +
      ((est.output / 1_000_000) * (model.pricing.outputPer1M.known ? model.pricing.outputPer1M.value : 0));
    if (approxCost > this.maxCostUsd) return base;

    const saving = expectedTierSaving(task, base.complexity, this.opts.models);
    if (saving <= approxCost * this.minSavingsFactor) return base;

    try {
      const res = await this.opts.complete({
        model,
        system: CLASSIFIER_SYSTEM,
        user: task.objective,
        maxOutputTokens: 120,
      });
      const parsed = parseClassification(res.text);
      if (!parsed) return { ...base, degraded: true };
      const out: Classification = {
        kind: parsed.kind ?? base.kind,
        complexity: parsed.complexity ?? base.complexity,
        confidence: parsed.confidence ?? 0.9,
        source: "model",
        costUsd: res.costUsd ?? approxCost,
      };
      this.cache.set(task, out);
      return out;
    } catch {
      return { ...base, degraded: true };
    }
  }
}

/**
 * Value of getting the tier right: the cost gap between the cheapest model
 * admitted at `complexity` and the cheapest model admitted one tier up.
 * Zero when no such pair exists — then classification cannot pay for itself.
 */
export function expectedTierSaving(
  task: TaskSpec,
  complexity: Complexity,
  models: ModelCapabilities[],
): number {
  const price = (m: ModelCapabilities): number | undefined => {
    if (m.pricing.kind !== "api" || !m.pricing.inputPer1M.known) return undefined;
    return m.pricing.inputPer1M.value;
  };
  const eligible = (tierComplexity: Complexity) =>
    models
      .filter((m) => tierMeetsComplexity(m.tier, tierComplexity))
      .map(price)
      .filter((p): p is number => p !== undefined)
      .sort((a, b) => a - b);

  const here = eligible(complexity)[0];
  const nextTier: Complexity =
    complexity === "simple" ? "moderate" : complexity === "moderate" ? "complex" : "complex";
  const up = eligible(nextTier)[0];
  if (here === undefined || up === undefined || up <= here) return 0;

  const { input, output } = estimateTokens(task, undefined);
  return ((input / 1_000_000) + (output / 1_000_000)) * (up - here);
}

function parseClassification(text: string): {
  kind?: TaskKind;
  complexity?: Complexity;
  confidence?: number;
} | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const obj = JSON.parse(match[0]) as Record<string, unknown>;
    return {
      kind: obj.kind as TaskKind | undefined,
      complexity: obj.complexity as Complexity | undefined,
      confidence: typeof obj.confidence === "number" ? obj.confidence : undefined,
    };
  } catch {
    return null;
  }
}

export { inferComplexity, inferKind };
