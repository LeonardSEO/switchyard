import type { ModelCapabilities } from "@switchyard/core";

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
}

export interface PiContextLike {
  modelRegistry: PiModelRegistryLike;
  cwd?: string;
  ui?: { notify?(message: string, level?: string): void };
}

export interface PiApiLike {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, handler: (event: any, ctx: PiContextLike) => unknown): void;
  setModel(model: PiModelLike): Promise<boolean> | boolean;
  setThinkingLevel(level: string): void | Promise<void>;
  getThinkingLevel?(): string;
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
    return name === token || name.endsWith(`-${token}`) || name.endsWith(`/${token}`);
  });
}

function normalise(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}
