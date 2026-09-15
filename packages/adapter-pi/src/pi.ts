import type { ModelCapabilities } from "@vepando/switchyard-core";

/**
 * Structural types for the bits of Pi's extension API we use.
 *
 * Deliberately not importing `@earendil-works/pi-coding-agent`: the adapter
 * should not drag a coding agent into its dependency tree, and structural
 * typing is enough for setModel/setThinkingLevel plus two events.
 */

export interface PiModelLike {
  id: string;
  provider: string;
  name?: string;
}

export interface PiModelRegistryLike {
  getAvailable(): PiModelLike[];
  find?(provider: string, id: string): PiModelLike | undefined;
  /**
   * Resolved credential, headers and base URL for a provider. Async in Pi, and
   * shaped `{ auth: { apiKey, headers, baseUrl } }`. This is how the adapter
   * avoids ever asking the user for a second API key.
   */
  getProviderAuth?(providerId: string): Promise<ProviderAuthResultLike | undefined>;
  getApiKeyForProvider?(providerId: string): Promise<string | undefined>;
}

export interface ResolvedAuthLike {
  apiKey?: string;
  headers?: Record<string, string>;
  baseUrl?: string;
}

export interface ProviderAuthResultLike {
  auth?: ResolvedAuthLike;
  source?: string;
}

export interface PiContextLike {
  modelRegistry: PiModelRegistryLike;
  /** Current model. OMP and recent Pi releases expose this to extensions. */
  model?: PiModelLike;
  cwd?: string;
  ui?: { notify?(message: string, level?: string): void };
}

export interface PiContextFileLike {
  path?: string;
  content?: string;
}

export interface PiBeforeAgentStartEventLike {
  prompt?: string;
  systemPromptOptions?: {
    cwd?: string;
    contextFiles?: PiContextFileLike[];
  };
}

export interface PiCommandLike {
  description?: string;
  handler(args: string, ctx: PiContextLike): Promise<void>;
}

export interface PiApiLike {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, handler: (event: any, ctx: PiContextLike) => unknown): void;
  setModel(model: PiModelLike): Promise<boolean> | boolean;
  setThinkingLevel(level: string): void | Promise<void>;
  getThinkingLevel?(): string;
  registerCommand?(name: string, command: PiCommandLike): void;
  registerProvider?(name: string, config: PiProviderConfigLike): void;
}

export interface PiProviderConfigLike {
  baseUrl: string;
  apiKey: string;
  api: "openai-completions";
  models: Array<{
    id: string;
    name: string;
    reasoning: boolean;
    input: Array<"text" | "image">;
    cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
    contextWindow: number;
    maxTokens: number;
  }>;
}

/**
 * Map a Switchyard catalog entry onto a model Pi can actually run.
 *
 * Our ids are OpenRouter ids ("deepseek/deepseek-v4-flash-0731") while Pi's
 * registry stores them under provider "openrouter" with the same id. Codex
 * roster entries ("codex-sol") have to be matched by name, since the Codex CLI
 * names them differently again.
 */
export function matchPiModel(model: ModelCapabilities, available: PiModelLike[]): PiModelLike | undefined {
  const exact = available.find((p) => p.id === model.id);
  if (exact) return exact;

  const bySuffix = available.find(
    (p) => p.id.endsWith(`/${model.id}`) || model.id.endsWith(`/${p.id}`),
  );
  if (bySuffix) return bySuffix;

  const token = normalise(model.displayName ?? model.id.split("/").pop() ?? model.id);
  if (!token) return undefined;
  return available.find((p) => {
    const name = normalise(p.name ?? p.id);
    if (name === token) return true;
    if (model.provider !== "codex-subscription") return false;
    return tokens(p.name ?? p.id).includes(token);
  });
}

function normalise(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function tokens(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map(normalise)
    .filter(Boolean);
}
