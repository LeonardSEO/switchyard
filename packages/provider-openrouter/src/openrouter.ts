import type { Known, ModelCapabilities, TaskKind, Tier } from "@switchyard/core";
import { known, unknown } from "@switchyard/core";

/**
 * OpenRouter catalog source.
 *
 * OpenRouter is the primary API catalog: ~450 models, live prices, context
 * windows, declared request capabilities, and — for roughly half of them —
 * Artificial Analysis benchmark scores. That last field is what makes
 * cold-start routing possible without any history of our own.
 */

export interface OpenRouterBenchmarks {
  artificial_analysis?: {
    intelligence_index?: number;
    coding_index?: number;
    agentic_index?: number;
  };
}

export interface OpenRouterModel {
  id: string;
  name?: string;
  canonical_slug?: string;
  context_length?: number;
  created?: number;
  description?: string;
  architecture?: {
    modality?: string;
    input_modalities?: string[];
    output_modalities?: string[];
    tokenizer?: string;
  };
  pricing?: Record<string, string | undefined>;
  top_provider?: { context_length?: number; max_completion_tokens?: number; is_moderated?: boolean };
  supported_parameters?: string[];
  reasoning?: { supported_efforts?: string[]; default_enabled?: boolean; mandatory?: boolean };
  benchmarks?: OpenRouterBenchmarks;
}

/**
 * Tier thresholds on the normalised coding index (0..1). Chosen from the live
 * catalog: 0.35 sits near the 25th percentile, 0.60 near the 75th, so roughly
 * a third of the catalog lands in each band.
 */
/** Rate-limited free tiers: expected-retry discount used by the scorer. */
export const FREE_TIER_RELIABILITY = 0.85;

export const TIER_THRESHOLDS = { large: 0.6, mid: 0.35 } as const;

export function tierFromCapability(score: number | undefined): Tier {
  if (score === undefined) return "unknown";
  if (score >= TIER_THRESHOLDS.large) return "large";
  if (score >= TIER_THRESHOLDS.mid) return "mid";
  return "small";
}

function parsePricePerMillion(raw: string | undefined): Known<number> {
  if (raw === undefined) return unknown("no price published");
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return unknown(`unparseable price ${raw}`);
  return known(n * 1_000_000);
}

export function mapOpenRouterModel(raw: OpenRouterModel): ModelCapabilities {
  const params = raw.supported_parameters ?? [];
  const toolCalling = params.includes("tools");
  const structuredOutput = params.includes("structured_outputs") || params.includes("response_format");
  const reasoning = params.includes("reasoning") || params.includes("include_reasoning");
  const codingIndex = raw.benchmarks?.artificial_analysis?.coding_index;
  const capabilityScore = codingIndex === undefined ? undefined : codingIndex / 100;

  const inputPer1M = parsePricePerMillion(raw.pricing?.prompt);
  const outputPer1M = parsePricePerMillion(raw.pricing?.completion);
  const freeTier = raw.id.endsWith(":free") || (inputPer1M.known && inputPer1M.value === 0);

  const strengths: TaskKind[] = [];
  const weaknesses: TaskKind[] = [];
  if (reasoning) strengths.push("plan", "debug");
  if (toolCalling) strengths.push("code-change", "refactor", "review");
  if (params.length > 0 && !toolCalling) weaknesses.push("code-change", "refactor");

  return {
    id: raw.id,
    provider: raw.id.split("/")[0] ?? "openrouter",
    displayName: raw.name,
    tier: tierFromCapability(capabilityScore),
    capabilityScore,
    capabilities: {
      toolCalling,
      structuredOutput,
      reasoning,
      reasoningEfforts: raw.reasoning?.supported_efforts,
    },
    maxContextTokens: raw.top_provider?.context_length ?? raw.context_length,
    strengths,
    weaknesses,
    freeTier: freeTier || undefined,
    batchOnly: raw.id.endsWith(":batch") || undefined,
    // Free variants are rate-limited by design: they lose to a reliable paid
    // model of equal capability once the retry tax is priced in.
    reliability: freeTier ? FREE_TIER_RELIABILITY : undefined,
    pricing: {
      kind: "api",
      inputPer1M,
      outputPer1M,
    },
  };
}

export interface SourceResult {
  source: string;
  models: ModelCapabilities[];
  fetchedAt: number;
  /** Served from cache past its TTL or after a failed refresh. */
  stale: boolean;
  note?: string;
}

export interface ModelSource {
  readonly id: string;
  list(force?: boolean): Promise<SourceResult>;
}

export interface OpenRouterSourceOptions {
  baseUrl?: string;
  apiKey?: string;
  /** Injectable for tests; defaults to global fetch. */
  fetchFn?: typeof fetch;
  cachePath?: string;
  ttlMs?: number;
  /** Cache backend; defaults to a JSON file at cachePath. */
  cache?: CatalogCache;
}

export interface CatalogCache {
  read(): Promise<CachedCatalog | undefined>;
  write(value: CachedCatalog): Promise<void>;
}

export interface CachedCatalog {
  fetchedAt: number;
  etag?: string;
  models: OpenRouterModel[];
}

export class FileCatalogCache implements CatalogCache {
  constructor(private readonly path: string) {}

  async read(): Promise<CachedCatalog | undefined> {
    try {
      const { readFile } = await import("node:fs/promises");
      return JSON.parse(await readFile(this.path, "utf8")) as CachedCatalog;
    } catch {
      return undefined;
    }
  }

  async write(value: CachedCatalog): Promise<void> {
    const { mkdir, writeFile } = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify(value), "utf8");
  }
}

/**
 * Fetches the full catalog, caches it with an ETag, and serves stale data
 * rather than failing when the network is unavailable. Routing must never
 * depend on a live HTTP call.
 */
export class OpenRouterSource implements ModelSource {
  readonly id = "openrouter";
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly fetchFn: typeof fetch;
  private readonly cache: CatalogCache;
  private readonly ttlMs: number;

  constructor(opts: OpenRouterSourceOptions = {}) {
    this.baseUrl = opts.baseUrl ?? "https://openrouter.ai/api/v1";
    this.apiKey = opts.apiKey ?? process.env.OPENROUTER_API_KEY;
    this.fetchFn = opts.fetchFn ?? globalThis.fetch.bind(globalThis);
    this.cache = opts.cache ?? new FileCatalogCache(opts.cachePath ?? defaultCachePath());
    this.ttlMs = opts.ttlMs ?? 6 * 60 * 60 * 1000;
  }

  async list(force = false): Promise<SourceResult> {
    const cached = await this.cache.read();
    const fresh = cached && Date.now() - cached.fetchedAt < this.ttlMs;
    if (cached && fresh && !force) {
      return {
        source: this.id,
        models: cached.models.map(mapOpenRouterModel),
        fetchedAt: cached.fetchedAt,
        stale: false,
      };
    }

    try {
      const headers: Record<string, string> = { accept: "application/json" };
      if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
      if (cached?.etag) headers["if-none-match"] = cached.etag;

      const res = await this.fetchFn(`${this.baseUrl}/models`, { headers });
      if (res.status === 304 && cached) {
        await this.cache.write({ ...cached, fetchedAt: Date.now() });
        return {
          source: this.id,
          models: cached.models.map(mapOpenRouterModel),
          fetchedAt: Date.now(),
          stale: false,
          note: "304 not modified",
        };
      }
      if (!res.ok) throw new Error(`openrouter ${res.status}`);

      const body = (await res.json()) as { data?: OpenRouterModel[] };
      const models = body.data ?? [];
      await this.cache.write({
        fetchedAt: Date.now(),
        etag: res.headers.get("etag") ?? cached?.etag,
        models,
      });
      return { source: this.id, models: models.map(mapOpenRouterModel), fetchedAt: Date.now(), stale: false };
    } catch (err) {
      if (cached) {
        return {
          source: this.id,
          models: cached.models.map(mapOpenRouterModel),
          fetchedAt: cached.fetchedAt,
          stale: true,
          note: `refresh failed (${(err as Error).message}); serving cached catalog`,
        };
      }
      return {
        source: this.id,
        models: [],
        fetchedAt: 0,
        stale: true,
        note: `unavailable and no cache: ${(err as Error).message}`,
      };
    }
  }
}

function defaultCachePath(): string {
  const home = process.env.HOME ?? ".";
  return `${home}/.switchyard/openrouter.json`;
}
