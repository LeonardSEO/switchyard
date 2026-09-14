import { describe, expect, it, vi } from "vitest";
import {
  mapOpenRouterModel,
  OpenRouterSource,
  tierFromCapability,
  type CachedCatalog,
  type CatalogCache,
  type OpenRouterModel,
} from "../src/index";
import type { ModelCapabilities } from "@switchyard/core";

const rawModel: OpenRouterModel = {
  id: "deepseek/deepseek-v4-flash-0731",
  name: "DeepSeek: V4 Flash",
  context_length: 1310720,
  pricing: { prompt: "0.000000075", completion: "0.0000002" },
  top_provider: { context_length: 1048576 },
  supported_parameters: ["tools", "structured_outputs", "reasoning", "max_tokens"],
  reasoning: { supported_efforts: ["low", "high", "max"] },
  benchmarks: { artificial_analysis: { coding_index: 69.1, intelligence_index: 34.5 } },
};

describe("openrouter mapping", () => {
  it("uses the published coding benchmark as a capability score and tier", () => {
    const m = mapOpenRouterModel(rawModel);
    expect(m.capabilityScore).toBeCloseTo(0.691);
    expect(m.tier).toBe("large");
    expect(tierFromCapability(0.4)).toBe("mid");
    expect(tierFromCapability(0.1)).toBe("small");
    expect(tierFromCapability(undefined)).toBe("unknown");
  });

  it("converts per-token prices to per-million and keeps context", () => {
    const m = mapOpenRouterModel(rawModel);
    // 0.000000075 USD/token => $0.075 per 1M tokens
    const inp = m.pricing.inputPer1M;
    const out = m.pricing.outputPer1M;
    expect(inp.known && inp.value).toBeCloseTo(0.075);
    expect(out.known && out.value).toBeCloseTo(0.2);
    expect(m.maxContextTokens).toBe(1048576);
  });

  it("treats a missing or broken price as unknown, not as free", () => {
    const noPrice = mapOpenRouterModel({ id: "x/y", supported_parameters: [] });
    expect(noPrice.pricing.inputPer1M.known).toBe(false);
    const broken = mapOpenRouterModel({ id: "x/y", pricing: { prompt: "nope" } });
    expect(broken.pricing.inputPer1M.known).toBe(false);
  });

  it("marks free variants as known-zero price and unknown capacity", () => {
    const free = mapOpenRouterModel({ id: "thinkingmachines/inkling:free", pricing: { prompt: "0" } });
    expect(free.pricing.inputPer1M).toEqual({ known: true, value: 0 });
    expect(free.freeTier).toBe(true);
  });

  it("derives strengths from declared capabilities and weaknesses from their absence", () => {
    const withTools = mapOpenRouterModel(rawModel);
    expect(withTools.strengths).toContain("code-change");
    expect(withTools.capabilities?.toolCalling).toBe(true);
    const noTools = mapOpenRouterModel({ id: "a/b", supported_parameters: ["max_tokens"] });
    expect(noTools.weaknesses).toContain("code-change");
  });
});

function memoryCache(initial?: CachedCatalog): CatalogCache & { value?: CachedCatalog } {
  const store: { value?: CachedCatalog } = { value: initial };
  return {
    store,
    async read() {
      return store.value;
    },
    async write(v: CachedCatalog) {
      store.value = v;
    },
    get value() {
      return store.value;
    },
  } as CatalogCache & { value?: CachedCatalog; store: { value?: CachedCatalog } };
}

function response(status: number, body: unknown, etag?: string): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (k: string) => (k.toLowerCase() === "etag" ? (etag ?? null) : null) },
    json: async () => body,
  } as unknown as Response;
}

describe("openrouter source", () => {
  it("serves a fresh cache without touching the network", async () => {
    const fetchFn = vi.fn();
    const cache = memoryCache({ fetchedAt: Date.now(), models: [rawModel] });
    const src = new OpenRouterSource({ fetchFn, cache });
    const res = await src.list();
    expect(fetchFn).not.toHaveBeenCalled();
    expect(res.models).toHaveLength(1);
    expect(res.stale).toBe(false);
  });

  it("keeps the catalog on a 304 and refreshes the timestamp", async () => {
    const cache = memoryCache({ fetchedAt: Date.now() - 7 * 3600_000, etag: "abc", models: [rawModel] });
    const fetchFn = vi.fn(async () => response(304, {}));
    const src = new OpenRouterSource({ fetchFn, cache });
    const res = await src.list();
    expect(res.note).toContain("304");
    expect(res.models).toHaveLength(1);
    expect(res.stale).toBe(false);
  });

  it("serves stale data rather than failing when the network is down", async () => {
    const cache = memoryCache({ fetchedAt: Date.now() - 48 * 3600_000, models: [rawModel] });
    const fetchFn = vi.fn(async () => {
      throw new Error("offline");
    });
    const src = new OpenRouterSource({ fetchFn, cache });
    const res = await src.list();
    expect(res.stale).toBe(true);
    expect(res.models).toHaveLength(1);
    expect(res.note).toContain("offline");
  });

  it("reports empty but does not throw when there is no cache at all", async () => {
    const src = new OpenRouterSource({
      fetchFn: vi.fn(async () => {
        throw new Error("offline");
      }),
      cache: memoryCache(),
    });
    const res = await src.list();
    expect(res.models).toEqual([]);
    expect(res.note).toContain("no cache");
  });

  it("caches a successful fetch with its etag", async () => {
    const cache = memoryCache();
    const src = new OpenRouterSource({
      fetchFn: vi.fn(async () => response(200, { data: [rawModel] }, "etag-1")) as never,
      cache,
    });
    const res = await src.list();
    expect(res.models).toHaveLength(1);
    expect(cache.value?.etag).toBe("etag-1");
    const first = res.models[0] as ModelCapabilities;
    expect(first.tier).toBe("large");
  });
});
