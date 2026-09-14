import type { Complexity, TaskKind, TaskSpec } from "./types";

/**
 * Complexity inference, ported from veto's pkg/router (keyword scoring) with
 * the matched keywords exposed so a route decision can explain itself.
 */

const HIGH = [
  "cqrs",
  "event sourcing",
  "event-driven",
  "microservices",
  "distributed system",
  "multi-tenant",
];
const MEDIUM = [
  "architecture",
  "infrastructure",
  "scalable",
  "enterprise",
  "system design",
  "from scratch",
  "production-grade",
];
const LOW = ["e2e", "pipeline", "service", "deploy", "integrate", "infra"];
const SIMPLE = ["simple", "basic", "quick", "hello world"];

export interface ComplexityEstimate {
  complexity: Complexity;
  score: number;
  matched: string[];
  source: "explicit" | "inferred";
}

export function inferKind(objective: string): TaskKind {
  const s = objective.toLowerCase();
  const any = (...words: string[]) => words.some((w) => s.includes(w));
  if (any("fix", "bug", "debug", "error", "crash", "broken", "failing")) return "debug";
  if (any("refactor", "clean up", "restructure", "rename", "extract method")) return "refactor";
  if (any("summarize", "summary", "tl;dr", "recap")) return "summarize";
  if (any("extract", "parse", "pull out", "scrape")) return "extract";
  if (any("review", "audit", "critique", "check")) return "review";
  if (any("plan", "design", "architect", "propose")) return "plan";
  return "code-change";
}

export function inferComplexity(
  objective: string,
  kind: TaskKind,
): ComplexityEstimate {
  const s = objective.toLowerCase();
  let score = 0;
  const matched: string[] = [];

  const apply = (words: string[], weight: number) => {
    for (const w of words) {
      if (s.includes(w)) {
        score += weight;
        matched.push(`${weight >= 0 ? "+" : ""}${weight}:${w}`);
      }
    }
  };

  apply(HIGH, 3);
  apply(MEDIUM, 2);
  apply(LOW, 1);
  apply(SIMPLE, -2);

  switch (kind) {
    case "plan":
      score += 2;
      matched.push("+2:kind=plan");
      break;
    case "debug":
      score += 1;
      matched.push("+1:kind=debug");
      break;
    case "extract":
    case "summarize":
      score -= 2;
      matched.push("-2:kind=" + kind);
      break;
    default:
      break;
  }

  const complexity: Complexity =
    score >= 7
      ? "frontier"
      : score >= 4
        ? "complex"
        : score >= 1
          ? "moderate"
          : score <= -3
            ? "trivial"
            : "simple";
  return { complexity, score, matched, source: "inferred" };
}

export function estimateComplexity(task: TaskSpec, kind: TaskKind): ComplexityEstimate {
  if (task.complexity) {
    return { complexity: task.complexity, score: 0, matched: [], source: "explicit" };
  }
  return inferComplexity(task.objective, kind);
}

/** Tier floor per complexity. "unknown" tiers only survive `simple` tasks. */
export function tierMeetsComplexity(tier: string, complexity: Complexity): boolean {
  switch (complexity) {
    case "complex":
      return tier === "large";
    case "moderate":
      return tier === "mid" || tier === "large";
    default:
      return true;
  }
}
