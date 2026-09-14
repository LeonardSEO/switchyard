/**
 * Core domain types for @switchyard/core.
 *
 * Ported concepts from veto (github.com/oleg-koval/veto, Apache-2.0) with one
 * deliberate extension: capacity/quota is a first-class routing input, and
 * "unknown", "known zero" and "known non-zero" are always distinct states.
 */

export type TaskKind =
  | "debug"
  | "refactor"
  | "summarize"
  | "extract"
  | "review"
  | "plan"
  | "code-change";

export type Complexity = "simple" | "moderate" | "complex";
export type Risk = "low" | "medium" | "high";

/** "unknown" is explicit: metadata that does not declare a tier must not be
 * treated as "small" (cheap) or "large" (capable). */
export type Tier = "small" | "mid" | "large" | "unknown";

/** Reasoning effort levels match pi's `setThinkingLevel` vocabulary so a route
 * decision can be applied directly by the pi adapter. */
export type ReasoningEffort =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

/** Three-state number: a known value, or explicitly unknown. Never 0-by-default. */
export type Known<T> = { known: true; value: T } | { known: false; reason?: string };

export const known = <T,>(value: T): Known<T> => ({ known: true, value });
export const unknown = <T,>(reason?: string): Known<T> => ({ known: false, reason });

export type PricingKind = "api" | "subscription" | "local";

/**
 * `subscription` models have no per-token invoice, but they are not free:
 * consuming quota now has an opportunity cost later in the window.
 * `planAmortizedPer1M` is that baseline (plan price / expected tokens per
 * window) and is the anchor the scarcity multiplier scales.
 */
export interface Pricing {
  kind: PricingKind;
  /** USD per 1M input tokens. */
  inputPer1M: Known<number>;
  /** USD per 1M output tokens. */
  outputPer1M: Known<number>;
  /** Amortized marginal price for subscription capacity, USD per 1M tokens. */
  planAmortizedPer1M?: Known<number>;
}

export interface Usage {
  /** Fraction of the window's capacity left, 0..1. */
  remainingFraction: number;
  /** Fraction of the window already elapsed, 0..1. */
  windowElapsedFraction: number;
  /** Epoch ms when the window resets. */
  resetsAtMs?: number;
  /** Where the number came from ("api" | "estimate" | "user" | ...). */
  source: string;
}

export type CapacityState =
  | {
      available: true;
      /** Absent = capacity is known-available but the level is not measured. */
      usage?: Usage;
    }
  | { available: false; reason: string; unavailableUntilMs?: number }
  | { available: "unknown"; reason?: string };

export interface ModelCapabilities {
  /** Stable identity used in route decisions: `provider/id`. */
  id: string;
  provider: string;
  displayName?: string;
  tier: Tier;
  /**
   * 0..1 coding capability from a public benchmark when available. This is the
   * cold-start quality prior: it replaces guesswork before any history exists.
   */
  capabilityScore?: number;
  /** Declared request-level capabilities (function calling, schema output, ...). */
  capabilities?: {
    toolCalling?: boolean;
    structuredOutput?: boolean;
    reasoning?: boolean;
    reasoningEfforts?: string[];
  };
  /** Free or rate-limited variant: the price is a known zero, capacity is not. */
  freeTier?: boolean;
  /** Asynchronous batch endpoint: cheap and capable, useless interactively. */
  batchOnly?: boolean;
  /**
   * 0..1, default 1. Probability-ish weight for "this call will just work".
   * Rate-limited free tiers, flaky endpoints and unmeasured capacity score
   * below 1: a cheap model that needs three retries is not cheap.
   */
  reliability?: number;
  /** Omit when unknown; a smaller number than the task needs prunes the model. */
  maxContextTokens?: number;
  /** Omit when unknown; `[]` means "known to support no tools". */
  supportsTools?: string[];
  strengths?: TaskKind[];
  weaknesses?: TaskKind[];
  pricing: Pricing;
}

/** Historical outcome signal, mirroring veto's RoutingSignal. */
export interface RoutingSignal {
  successRate: number;
  rejectRate: number;
  /** Omit when no evals have been recorded. */
  evalScore?: number;
  avgInputTokens?: number;
  avgOutputTokens?: number;
}

/**
 * Reserved for session-aware (per-step) routing. v0.1 scoring does not use it,
 * but the field exists so adding it later is not a breaking change.
 */
export interface SessionContext {
  stepsCompleted?: number;
  priorModelIds?: string[];
  /** Remaining planned steps, most complex first. */
  upcomingComplexity?: Complexity[];
}

export interface TaskSpec {
  id?: string;
  objective: string;
  /** Omit to infer from the objective. */
  kind?: TaskKind;
  /** Omit to infer from the objective. */
  complexity?: Complexity;
  risk?: Risk;
  /** Tokens already in context, when the harness reports them. */
  contextTokens?: number;
  requiredTools?: string[];
  /** 0 or omitted = no ceiling. */
  maxCostUsd?: number;
  /** Models already tried in an interrupted run. */
  skipModels?: string[];
  /** Allow asynchronous batch endpoints. Off by default: coding agents wait. */
  allowBatch?: boolean;
  session?: SessionContext;
}
