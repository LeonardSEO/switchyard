import type { CapacityState, ModelCapabilities } from "@vepando/switchyard-core";

/**
 * Execute a chat request on a Codex subscription.
 *
 * The gateway needs this to make subscription capacity real outside Pi. It talks
 * to the same backend the Codex CLI uses, with the credential `codex login`
 * already stored — no new keys, no scraping. The backend requires `stream: true`
 * and `store: false`; non-streaming callers get the stream aggregated.
 *
 * This is an undocumented backend. If it changes, callers must fail over to API
 * routing rather than break the turn.
 */

export interface CodexAuth {
  accessToken?: string;
  accountId?: string;
}

export interface CodexExecOptions {
  authPath?: string;
  endpoint?: string;
  fetchFn?: typeof fetch;
  readAuth?: (path: string) => Promise<CodexAuth>;
}

export interface CodexResult {
  text: string;
  model: string;
}

export interface CodexChatRequest {
  messages?: Array<{ role?: string; content?: unknown }>;
  max_tokens?: number;
}

const DEFAULT_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";

export function defaultAuthPath(home = process.env.HOME ?? "."): string {
  return `${process.env.CODEX_HOME ?? `${home}/.codex`}/auth.json`;
}

export async function readCodexAuth(path = defaultAuthPath()): Promise<CodexAuth> {
  try {
    const { readFile } = await import("node:fs/promises");
    const raw = JSON.parse(await readFile(path, "utf8")) as {
      tokens?: { access_token?: string; account_id?: string };
    };
    return { accessToken: raw.tokens?.access_token, accountId: raw.tokens?.account_id };
  } catch {
    return {};
  }
}

/** Map our roster ids (codex-sol) onto the backend's ids (gpt-5.6-sol). */
export function codexModelId(model: ModelCapabilities): string {
  const fromCatalog = (model as { codexId?: string }).codexId;
  if (fromCatalog) return fromCatalog;
  const id = model.id.startsWith("codex-") ? model.id.slice("codex-".length) : model.id;
  return `gpt-5.6-${id}`;
}

export async function executeCodex(
  messages: Array<{ role?: string; content?: unknown }>,
  model: ModelCapabilities,
  opts: CodexExecOptions = {},
): Promise<CodexResult> {
  return executeCodexRequest({ messages }, model, opts);
}

export async function executeCodexRequest(
  request: CodexChatRequest,
  model: ModelCapabilities,
  opts: CodexExecOptions = {},
): Promise<CodexResult> {
  const auth = await (opts.readAuth ?? readCodexAuth)(opts.authPath ?? defaultAuthPath());
  if (!auth.accessToken) throw new Error("no codex login");

  const fetchFn = opts.fetchFn ?? globalThis.fetch.bind(globalThis);
  const res = await fetchFn(opts.endpoint ?? DEFAULT_ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${auth.accessToken}`,
      ...(auth.accountId ? { "chatgpt-account-id": auth.accountId } : {}),
    },
    body: JSON.stringify({
      model: codexModelId(model),
      instructions: toCodexInstructions(request.messages ?? []),
      input: toCodexInput(request.messages ?? []),
      ...(request.max_tokens === undefined ? {} : { max_output_tokens: request.max_tokens }),
      stream: true,
      store: false,
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`codex backend ${res.status}: ${detail.slice(0, 120)}`);
  }
  return { text: await collectText(res.body), model: codexModelId(model) };
}

function toCodexInstructions(messages: Array<{ role?: string; content?: unknown }>): string | undefined {
  const instructions = messages
    .filter((m) => m?.role === "system" || m?.role === "developer")
    .map((m) => flatten(m.content))
    .filter(Boolean)
    .join("\n\n");
  return instructions || undefined;
}

/** Aggregate an SSE stream into plain text. */
export async function collectText(
  body: ReadableStream<Uint8Array> | null | undefined,
): Promise<string> {
  if (!body) return "";
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const event = JSON.parse(payload) as { type?: string; delta?: string };
        if (event.type === "response.output_text.delta" && event.delta) text += event.delta;
      } catch {
        /* ignore partial frames */
      }
    }
  }
  return text;
}

function toCodexInput(messages: Array<{ role?: string; content?: unknown }>) {
  return messages
    .filter((m) => m?.role === "user" || m?.role === "assistant")
    .map((m) => ({
      type: "message",
      role: m.role,
      content: [{ type: m.role === "assistant" ? "output_text" : "input_text", text: flatten(m.content) }],
    }));
}

function flatten(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (typeof part === "string" ? part : ((part as { text?: string })?.text ?? "")))
    .filter(Boolean)
    .join("\n");
}
