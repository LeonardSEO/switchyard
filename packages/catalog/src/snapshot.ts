import type { CapacityState, ModelCapabilities } from "@switchyard/core";
import { OpenRouterSource } from "@switchyard/provider-openrouter";
import { CodexSubscriptionSource, type CodexSourceOptions } from "./codex-subscription";
import { detectCodexEnvironment } from "./codex-subscription";
import { loadCodexModels, resolveRoster, type CapabilityMatch } from "./codex-models";
import { readCodexUsage, type UsageReading } from "./codex-usage";
import { OpenAICompatibleSource } from "./local";
import { Catalog, type SourceStatus } from "./catalog";

export interface Snapshot {
  models: ModelCapabilities[];
  capacity: Record<string, CapacityState>;
  status: SourceStatus[];
  usage: UsageReading;
  matches: CapabilityMatch[];
  codexRoster: "override" | "default";
}

export interface SnapshotOptions {
  force?: boolean;
  /** Extra OpenAI-compatible endpoints (Ollama, LM Studio, corporate gateway). */
  localEndpoints?: Array<{ id: string; baseUrl: string }>;
  /** Skip reading real quota (tests, air-gapped machines). */
  skipUsage?: boolean;
}

/**
 * The one way to assemble the candidate pool. Order matters: the API catalog is
 * fetched first so the Codex roster can be resolved against it (measured
 * benchmarks instead of declared guesses), and real quota is read before
 * capacity is built.
 */
export async function buildSnapshot(opts: SnapshotOptions = {}): Promise<Snapshot> {
  const endpoints = opts.localEndpoints ?? [
    { id: "ollama", baseUrl: "http://localhost:11434/v1" },
    { id: "lm-studio", baseUrl: "http://localhost:1234/v1" },
  ];
  const apiSources = [
    new OpenRouterSource(),
    ...endpoints.map((e) => new OpenAICompatibleSource(e)),
  ];

  const apiModels: ModelCapabilities[] = [];
  for (const s of apiSources) {
    const r = await s.list(opts.force ?? false);
    apiModels.push(...r.models);
  }

  const { models: roster, source: codexRoster } = await loadCodexModels();
  const { specs, matches } = resolveRoster(roster, apiModels);

  const usage = opts.skipUsage
    ? ({ source: "none", note: "quota reading skipped" } as UsageReading)
    : await readCodexUsage();

  const unavailableIds: string[] = [];
  for (const m of matches) {
    const upstream = m.matchedCatalogId?.split("/")[1];
    if (!upstream) continue;
    if (usage.modelAvailability && usage.modelAvailability[upstream] === false) {
      unavailableIds.push(m.id);
    }
  }

  const env = await detectCodexEnvironment();
  const codexOpts: CodexSourceOptions = { usage: usage.usage, unavailableIds };
  const catalog = new Catalog(
    apiSources,
    new CodexSubscriptionSource(specs, env, codexOpts),
  );
  const snap = await catalog.refresh(opts.force ?? false);

  return {
    models: snap.models,
    capacity: snap.capacity,
    status: snap.status,
    usage,
    matches,
    codexRoster,
  };
}
