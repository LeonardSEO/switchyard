import type { ModelCapabilities } from "@vepando/switchyard-core";
import type { ModelSource, SourceResult } from "@vepando/switchyard-provider-openrouter";

/**
 * Any OpenAI-compatible endpoint that lists its models: Ollama, LM Studio,
 * llama.cpp, vLLM, a corporate gateway. Local weights cost nothing per token,
 * so price is a known zero — not unknown.
 */
export interface LocalSourceOptions {
  id: string;
  baseUrl: string;
  fetchFn?: typeof fetch;
  apiKey?: string;
}

export class OpenAICompatibleSource implements ModelSource {
  private readonly fetchFn: typeof fetch;

  constructor(private readonly opts: LocalSourceOptions) {
    this.fetchFn = opts.fetchFn ?? globalThis.fetch.bind(globalThis);
  }

  get id(): string {
    return this.opts.id;
  }

  async list(): Promise<SourceResult> {
    try {
      const headers: Record<string, string> = { accept: "application/json" };
      if (this.opts.apiKey) headers.authorization = `Bearer ${this.opts.apiKey}`;
      const res = await this.fetchFn(`${this.opts.baseUrl.replace(/\/$/, "")}/models`, { headers });
      if (!res.ok) throw new Error(`${this.opts.id} ${res.status}`);
      const body = (await res.json()) as { data?: Array<{ id: string }> };
      const models: ModelCapabilities[] = (body.data ?? []).map((m) => ({
        id: `${this.opts.id}/${m.id}`,
        provider: this.opts.id,
        displayName: m.id,
        tier: "unknown",
        maxContextTokens: undefined,
        pricing: {
          kind: "local",
          inputPer1M: { known: true, value: 0 },
          outputPer1M: { known: true, value: 0 },
        },
      }));
      return { source: this.id, models, fetchedAt: Date.now(), stale: false };
    } catch (err) {
      return {
        source: this.id,
        models: [],
        fetchedAt: 0,
        stale: false,
        note: `not reachable: ${(err as Error).message}`,
      };
    }
  }
}
