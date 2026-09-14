import type { CompletionFn, CompletionRequest, CompletionResult } from "@vepando/switchyard-core";
import type { PiContextLike } from "./pi.js";

/**
 * A completion call that borrows Pi's existing credentials.
 *
 * The classifier is the one component that may need a model, and it must not
 * become a reason to store a second API key. Pi already holds the OpenRouter
 * (or Codex, or Anthropic) login; we ask its registry for the resolved key,
 * headers and base URL and use those for a single small call.
 */

export interface ResolvedAuth {
  apiKey?: string;
  headers?: Record<string, string>;
  baseUrl?: string;
}

export interface CompletionOptions {
  /** Defaults to the OpenRouter provider Pi has configured. */
  providerId?: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

export function createPiCompletion(
  ctx: PiContextLike,
  opts: CompletionOptions = {},
): CompletionFn {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  return async (req: CompletionRequest): Promise<CompletionResult> => {
    const fetchFn = opts.fetchFn ?? globalThis.fetch.bind(globalThis);
    // Our API catalog is OpenRouter ids, so that is the credential we need.
    // (Writing `a ?? b ? c : d` silently parses as `(a ?? b) ? c : d`.)
    const providerId = opts.providerId ?? "openrouter";
    const result = await ctx.modelRegistry.getProviderAuth?.(providerId);
    const apiKey =
      result?.auth?.apiKey ??
      (await ctx.modelRegistry.getApiKeyForProvider?.(providerId));
    const baseUrl = (result?.auth?.baseUrl ?? "https://openrouter.ai/api/v1").replace(/\/$/, "");

    const headers: Record<string, string> = {
      "content-type": "application/json",
      ...(result?.auth?.headers ?? {}),
    };
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      await debug(
        `classifier request: model=${req.model.id} system=${req.system.length}ch user=${req.user.length}ch`,
      );
      const res = await fetchFn(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        signal: controller.signal,
        body: JSON.stringify({
          model: req.model.id,
          messages: [
            { role: "system", content: req.system },
            { role: "user", content: req.user },
          ],
          max_tokens: req.maxOutputTokens,
          temperature: 0,
          // Reasoning models otherwise spend the whole output budget thinking
          // and return null content instead of the one JSON line we need.
          ...(req.model.capabilities?.reasoning
            ? { reasoning: { effort: "minimal" }, include_reasoning: false }
            : {}),
        }),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        await debug(`classifier ${res.status} ${detail.slice(0, 300)}`);
        throw new Error(`classifier call failed: ${res.status}`);
      }
      const body = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const text = body.choices?.[0]?.message?.content ?? "";
      await debug(`classifier response: ${JSON.stringify(body).slice(0, 400)}`);
      const costUsd = costOf(req.model, body.usage);
      return { text, costUsd };
    } catch (err) {
      await debug(`classifier error: ${(err as Error).message}`);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  };
}

/** Writes to ~/.switchyard/debug.log only when SWITCHYARD_DEBUG is set. */
async function debug(message: string): Promise<void> {
  if (!process.env.SWITCHYARD_DEBUG) return;
  try {
    const { appendFile, mkdir } = await import("node:fs/promises");
    const dir = `${process.env.HOME ?? "."}/.switchyard`;
    await mkdir(dir, { recursive: true });
    await appendFile(`${dir}/debug.log`, `${new Date().toISOString()} ${message}\n`, "utf8");
  } catch {
    /* never break a turn for logging */
  }
}

function costOf(
  model: { pricing: { inputPer1M: { known: boolean; value?: number }; outputPer1M: { known: boolean; value?: number } } },
  usage?: { prompt_tokens?: number; completion_tokens?: number },
): number | undefined {
  if (!usage) return undefined;
  const input = usage.prompt_tokens ?? 0;
  const output = usage.completion_tokens ?? 0;
  const inPrice = model.pricing.inputPer1M.known ? model.pricing.inputPer1M.value : undefined;
  const outPrice = model.pricing.outputPer1M.known ? model.pricing.outputPer1M.value : undefined;
  if (inPrice === undefined || outPrice === undefined) return undefined;
  return (input / 1_000_000) * inPrice + (output / 1_000_000) * outPrice;
}
