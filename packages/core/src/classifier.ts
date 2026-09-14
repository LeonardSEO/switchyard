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
  /**
   * Reasoning models spend their output budget thinking and return null
   * content, which is useless for a one-line JSON answer. Off by default.
   */
  allowReasoning?: boolean;
  /** Upper bound on acceptable classifier latency; models measured slower are skipped. */
  maxLatencyMs?: number;
  /** Measured latency per model, from previous calls. */
  latencyMs?: (model: ModelCapabilities) => number | undefined;
  /** Prefer a local model (Ollama, LM Studio): no network, nothing leaves the machine. */
  preferLocal?: boolean;
}

export const defaultClassifierFloors: ClassifierFloors = {
  minContextTokens: 16_000,
  requireStructuredOutput: true,
  allowFreeTier: false,
  allowBatch: false,
  allowReasoning: false,
  requireBenchmark: true,
  minCapabilityScore: 0.2,
  maxLatencyMs: 800,
  preferLocal: true,
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
  // A local model wins outright: no network round trip and nothing leaves the
  // machine. Classification is the one place where capability barely matters.
  if (floors.preferLocal !== false) {
    const local = models
      .filter((m) => m.pricing.kind === "local")
      .filter((m) => (m.maxContextTokens ?? 0) >= floors.minContextTokens)
      .sort((a, b) => a.id.localeCompare(b.id));
    if (local.length > 0) return local[0];
  }

  const tierRank = { small: 0, mid: 1, large: 2, unknown: -1 } as const;
  const minTier = floors.minTier ? tierRank[floors.minTier] : -1;
  // Two passes: prefer models measured within the latency budget, but never end
  // up with nothing. Falling back to keywords because every model was slow would
  // cost far more accuracy than the latency saves.
  const eligible: ModelCapabilities[] = [];
  for (const m of models) {
    if (m.pricing.kind !== "api") continue;
    if (!m.pricing.inputPer1M.known) continue;
    if ((m.maxContextTokens ?? 0) < floors.minContextTokens) continue;
    if (floors.denylist?.includes(m.id)) continue;
    if (!floors.allowFreeTier && m.freeTier) continue;
    if (!floors.allowBatch && m.batchOnly) continue;
    if (floors.requireStructuredOutput && m.capabilities?.structuredOutput !== true) continue;
    // A reasoning model burns the output budget on thinking and answers null.
    if (!floors.allowReasoning && m.capabilities?.reasoning === true) continue;
    // Unmeasured means unknown, and unknown cannot be trusted with the
    // decision that gates every other decision.
    if (floors.requireBenchmark !== false) {
      if (m.capabilityScore === undefined) continue;
      if (m.capabilityScore < (floors.minCapabilityScore ?? 0)) continue;
    }
    if (tierRank[m.tier] < minTier) continue;
    const measured = floors.latencyMs?.(m);
    eligible.push(m);
  }
  if (eligible.length === 0) return undefined;

  const maxLatency = floors.maxLatencyMs ?? Number.POSITIVE_INFINITY;
  const withinBudget = eligible.filter((m) => {
    const measured = floors.latencyMs?.(m);
    return measured === undefined || measured <= maxLatency;
  });

  const pool = withinBudget.length > 0 ? withinBudget : eligible;
  const key = (m: ModelCapabilities) =>
    withinBudget.length > 0
      ? (m.pricing.inputPer1M.known ? m.pricing.inputPer1M.value : Infinity)
      : (floors.latencyMs?.(m) ?? Number.POSITIVE_INFINITY);

  return pool.reduce((best, m) => (key(m) < key(best) ? m : best));
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
  /**
   * When to spend a call. "uncertain" (default) only asks when the keyword
   * score sits near a threshold; "always" asks for every task, which is right
   * when the rung is worth more than the latency; "never" is offline mode.
   */
  escalation?: "uncertain" | "always" | "never";
}

/**
 * Cap on what leaves the machine. The classifier needs the shape of the task,
 * not the pasted source, and an unbounded objective is an unbounded bill.
 */
export const MAX_OBJECTIVE_CHARS = 4000;

export function truncateObjective(objective: string, max = MAX_OBJECTIVE_CHARS): string {
  if (objective.length <= max) return objective;
  return `${objective.slice(0, max)}\n[truncated]`;
}

/** Bump when the prompt changes: cached answers belong to the old prompt. */
export const CLASSIFIER_PROMPT_VERSION = 2;

export const COMPLEXITIES = [
  "trivial",
  "simple",
  "moderate",
  "advanced",
  "complex",
  "frontier",
] as const;

export const KINDS = [
  "debug",
  "refactor",
  "summarize",
  "extract",
  "review",
  "plan",
  "code-change",
] as const;

const CLASSIFIER_SYSTEM = `You classify one coding task for a model router that decides which LLM runs it.

Reply with JSON only. No prose, no markdown, no code fences.

Complexity rungs (choose exactly one):
- trivial: one mechanical edit in one place, no design decision (rename, reformat, add an import).
- simple: small self-contained change in one file, the solution is obvious (add validation, tweak a helper).
- moderate: multi-file feature, or a contained bug fix inside one component.
- advanced: new subsystem or cross-cutting change needing design choices (an API with pagination and filtering, a refactor across modules).
- complex: concurrency, distributed systems, data migration, cross-service debugging, or ambiguous requirements.
- frontier: greenfield architecture, or rewriting a core system where most decisions are still open.

If you are torn between two rungs, pick the higher one: a stronger model costs less than a failed attempt.

Kind (choose exactly one): debug, refactor, summarize, extract, review, plan, code-change.

Fields, in this order:
{"kind":<kind>,"complexity":<rung>,"confidence":<0..1>,"why":"<=8 words"}

Use only the values listed above. If the task is too vague to judge, use complexity "moderate" and confidence 0.3 or lower.`;

export class ClassificationCache {
  private map = new Map<string, Classification>();
  constructor(private readonly maxEntries = 500) {}

  static key(task: TaskSpec): string {
    return `v${CLASSIFIER_PROMPT_VERSION}|${task.kind ?? ""}|${task.objective
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ")}`;
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

    if (this.opts.escalation === "never") return base;
    if (this.opts.escalation !== "always" && !isUncertain(base)) return base;

    const model =
      this.opts.models.find((m) => m.id === this.opts.modelId) ??
      pickCheapestClassifier(this.opts.models, this.floors);
    if (!model) return base;

    // Cost the classification prompt, not the task. The classifier only sends
    // the system prompt plus the objective — never the repository context — so
    // charging it the task's token estimate inflates it ~100x and the savings
    // gate then refuses to escalate for anything.
    const approxCost = classificationCost(model, task);
    if (approxCost > this.maxCostUsd) return base;

    // 0 disables the gate entirely. It exists to skip classification when the
    // rung cannot change anything, but a non-zero saving is not measurable from
    // tier price deltas alone: cheap models qualify for every rung.
    if (this.minSavingsFactor > 0) {
      const saving = expectedTierSaving(task, base.complexity, this.opts.models);
      if (saving <= approxCost * this.minSavingsFactor) return base;
    }

    try {
      const res = await this.opts.complete({
        model,
        system: CLASSIFIER_SYSTEM,
        user: truncateObjective(task.objective),
        // Reasoning models, and providers that ignore reasoning controls, can
        // burn a surprising number of tokens before the JSON line.
        maxOutputTokens: 800,
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

/** What the classification call actually costs: system prompt + objective. */
export function classificationCost(model: ModelCapabilities, task: TaskSpec): number {
  const promptTokens =
    Math.ceil((CLASSIFIER_SYSTEM.length + task.objective.length) / 4) + 16;
  const outputTokens = 80;
  const inputPrice = model.pricing.inputPer1M.known ? model.pricing.inputPer1M.value : 0;
  const outputPrice = model.pricing.outputPer1M.known ? model.pricing.outputPer1M.value : 0;
  return (promptTokens / 1_000_000) * inputPrice + (outputTokens / 1_000_000) * outputPrice;
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
    // Validate instead of casting: a hallucinated rung ("hard") would otherwise
    // flow straight into the router and prune every capable model.
    const kind = KINDS.includes(obj.kind as (typeof KINDS)[number])
      ? (obj.kind as TaskKind)
      : undefined;
    const complexity = COMPLEXITIES.includes(obj.complexity as (typeof COMPLEXITIES)[number])
      ? (obj.complexity as Complexity)
      : undefined;
    return {
      kind,
      complexity,
      confidence: typeof obj.confidence === "number" ? obj.confidence : undefined,
    };
  } catch {
    return null;
  }
}

export { inferComplexity, inferKind };
