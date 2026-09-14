import { readFile } from "node:fs/promises";
import type { ModelCapabilities } from "@switchyard/core";
import { defaultCodexModels, type CodexModelSpec } from "./codex-subscription";

/**
 * The Codex roster is the one list we cannot fetch — OpenAI publishes no catalog
 * for the models behind a ChatGPT login. But the *same models* are usually on
 * OpenRouter under a different name, with a published benchmark. So: declare the
 * roster, then resolve each entry against the live catalog by name and take the
 * measured score. Guessing 0.5 for Luna when it actually measures 0.71 is how a
 * router quietly misroutes.
 */

export async function loadCodexModels(
  path = `${process.env.HOME ?? "."}/.switchyard/codex-models.json`,
): Promise<{ models: CodexModelSpec[]; source: "override" | "default" }> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0) {
      return { models: defaultCodexModels, source: "default" };
    }
    const models = parsed.filter(isCodexModelSpec);
    if (models.length === 0) return { models: defaultCodexModels, source: "default" };
    return { models, source: "override" };
  } catch {
    return { models: defaultCodexModels, source: "default" };
  }
}

function isCodexModelSpec(v: unknown): v is CodexModelSpec {
  if (typeof v !== "object" || v === null) return false;
  const m = v as Record<string, unknown>;
  return typeof m.id === "string" && typeof m.amortizedPer1M === "number";
}

export interface CapabilityMatch {
  id: string;
  matchedCatalogId?: string;
  capability?: number;
  origin: "benchmark" | "declared" | "unknown";
}

/**
 * Match a roster entry to a catalog model by name token: "Luna" matches
 * `openai/gpt-5.6-luna`. Entries with a published score win over variants
 * without one; among equals, the cheaper one is the canonical entry.
 */
export function matchCapability(
  spec: CodexModelSpec,
  catalog: ModelCapabilities[],
): CapabilityMatch {
  const name = (spec.displayName ?? spec.id).toLowerCase();
  const candidates = catalog.filter((m) => {
    const id = m.id.toLowerCase();
    const tokens = id.split(/[/\-:.]/);
    return tokens.includes(name) || id.endsWith(`/${name}`) || id.endsWith(`-${name}`);
  });
  // Prefer a canonical interactive entry over a :batch or :free variant.
  const interactive = candidates.filter((m) => !m.batchOnly && !m.freeTier);
  const withScore = (list: typeof candidates) => list.filter((m) => m.capabilityScore !== undefined);
  const pool =
    withScore(interactive).length > 0
      ? withScore(interactive)
      : interactive.length > 0
        ? interactive
        : candidates;
  if (pool.length === 0) {
    return {
      id: spec.id,
      capability: spec.declaredCapability,
      origin: spec.declaredCapability === undefined ? "unknown" : "declared",
    };
  }
  const best = pool.reduce((a, b) => {
    const pa = a.pricing.inputPer1M.known ? a.pricing.inputPer1M.value : Number.POSITIVE_INFINITY;
    const pb = b.pricing.inputPer1M.known ? b.pricing.inputPer1M.value : Number.POSITIVE_INFINITY;
    return pb < pa ? b : a;
  });
  return {
    id: spec.id,
    matchedCatalogId: best.id,
    capability: best.capabilityScore ?? spec.declaredCapability,
    origin: best.capabilityScore === undefined ? "declared" : "benchmark",
  };
}

/** Attach resolved capability scores to the roster before it becomes models. */
export function resolveRoster(
  specs: CodexModelSpec[],
  catalog: ModelCapabilities[],
): { specs: CodexModelSpec[]; matches: CapabilityMatch[] } {
  const matches = specs.map((s) => matchCapability(s, catalog));
  const resolved = specs.map((spec, i) => {
    const m = matches[i];
    if (m?.capability === undefined) return spec;
    return { ...spec, declaredCapability: m.capability };
  });
  return { specs: resolved, matches };
}
