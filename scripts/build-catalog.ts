/**
 * Shared snapshot builder for the CLI scripts.
 *
 * Order matters: the API catalog is fetched first so the Codex roster can be
 * resolved against it (real benchmarks instead of declared guesses), and real
 * quota is read before capacity is built.
 */
import type { ModelCapabilities } from "@switchyard/core";
import { OpenRouterSource } from "@switchyard/provider-openrouter";
import {
  Catalog,
  CodexSubscriptionSource,
  OpenAICompatibleSource,
  detectCodexEnvironment,
  loadCodexModels,
  readCodexUsage,
  resolveRoster,
  type CapabilityMatch,
  type SourceStatus,
  type UsageReading,
} from "@switchyard/catalog";

export interface Snapshot {
  models: ModelCapabilities[];
  capacity: Record<string, import("@switchyard/core").CapacityState>;
  status: SourceStatus[];
  usage: UsageReading;
  matches: CapabilityMatch[];
  codexRoster: "override" | "default";
}

export async function buildSnapshot(force = false): Promise<Snapshot> {
  const apiSources = [
    new OpenRouterSource(),
    new OpenAICompatibleSource({ id: "ollama", baseUrl: "http://localhost:11434/v1" }),
    new OpenAICompatibleSource({ id: "lm-studio", baseUrl: "http://localhost:1234/v1" }),
  ];

  const apiModels: ModelCapabilities[] = [];
  for (const s of apiSources) {
    const r = await s.list(force);
    apiModels.push(...r.models);
  }

  const { models: roster, source: codexRoster } = await loadCodexModels();
  const { specs, matches } = resolveRoster(roster, apiModels);

  const usage = await readCodexUsage();

  // Map upstream availability ("gpt-6-astra") onto our roster ids.
  const unavailableIds: string[] = [];
  for (const m of matches) {
    const upstream = m.matchedCatalogId?.split("/")[1];
    if (!upstream) continue;
    if (usage.modelAvailability && usage.modelAvailability[upstream] === false) {
      unavailableIds.push(m.id);
    }
  }

  const env = await detectCodexEnvironment();
  const catalog = new Catalog(
    apiSources,
    new CodexSubscriptionSource(specs, env, { usage: usage.usage, unavailableIds }),
  );
  const snap = await catalog.refresh(force);

  return {
    models: snap.models,
    capacity: snap.capacity,
    status: snap.status,
    usage,
    matches,
    codexRoster,
  };
}
