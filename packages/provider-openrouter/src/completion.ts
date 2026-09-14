import type { CompletionFn, CompletionRequest } from "@vepando/switchyard-core";

/**
 * Minimal OpenRouter completion, used by the classifier and by evaluation
 * scripts. Deliberately small: one request, no streaming, no retries.
 */

export interface OpenRouterCompletionOptions {
  apiKey?: string;
  baseUrl?: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

export function createOpenRouterCompletion(
  opts: OpenRouterCompletionOptions = {},
): CompletionFn {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const baseUrl = (opts.baseUrl ?? "https://openrouter.ai/api/v1").replace(/\/$/, "");

  return async (req: CompletionRequest): Promise<{ text: string; costUsd?: number }> => {
    const fetchFn = opts.fetchFn ?? globalThis.fetch.bind(globalThis);
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (opts.apiKey) headers.authorization = `Bearer ${opts.apiKey}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
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
          ...(req.model.capabilities?.reasoning
            ? { reasoning: { effort: "minimal" }, include_reasoning: false }
            : {}),
        }),
      });
      if (!res.ok) throw new Error(`completion failed: ${res.status}`);
      const body = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      return {
        text: body.choices?.[0]?.message?.content ?? "",
        costUsd: usageCost(req.model, body.usage),
      };
    } finally {
      clearTimeout(timer);
    }
  };
}

function usageCost(
  model: CompletionRequest["model"],
  usage?: { prompt_tokens?: number; completion_tokens?: number },
): number | undefined {
  if (!usage) return undefined;
  const input = usage.prompt_tokens ?? 0;
  const output = usage.completion_tokens ?? 0;
  if (!model.pricing.inputPer1M.known || !model.pricing.outputPer1M.known) return undefined;
  return (
    (input / 1_000_000) * model.pricing.inputPer1M.value +
    (output / 1_000_000) * model.pricing.outputPer1M.value
  );
}
