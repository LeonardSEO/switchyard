import type { ModelCapabilities } from "@vepando/switchyard-core";

/**
 * Request routing for the OpenAI-compatible gateway.
 *
 * The gateway exists because not every harness has a hook rich enough to choose
 * a model per request. Any tool that can talk to an OpenAI-compatible endpoint
 * can use it: OpenCode via a custom provider, Cursor, Cline, aider, raw curl.
 * Point them at `http://127.0.0.1:8787/v1` with model `switchyard/auto`.
 */

export interface ChatMessage {
  role?: string;
  content?: unknown;
  tool_calls?: unknown;
  [key: string]: unknown;
}

/** Codex subscription execution currently supports text conversations only. */
export function requiresApiExecution(body: ChatRequest): boolean {
  const supportedFields = new Set(["model", "messages", "stream", "max_tokens"]);
  if (Object.keys(body).some((field) => !supportedFields.has(field))) return true;
  if (Array.isArray(body.tools) && body.tools.length > 0) return true;
  return (body.messages ?? []).some(
    (message) =>
      !["system", "developer", "user", "assistant"].includes(message.role ?? "") ||
      message.tool_calls !== undefined ||
      !isTextContent(message.content),
  );
}

function isTextContent(content: unknown): boolean {
  if (typeof content === "string") return true;
  if (!Array.isArray(content)) return content === null || content === undefined;
  return content.every(
    (part) =>
      typeof part === "string" ||
      (typeof part === "object" &&
        part !== null &&
        ["text", "input_text", "output_text"].includes(String((part as { type?: unknown }).type)) &&
        typeof (part as { text?: unknown }).text === "string"),
  );
}

export interface ChatRequest {
  model?: string;
  messages?: ChatMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  [key: string]: unknown;
}

const MAX_OBJECTIVE_CHARS = 4_000;

/** The objective is the last user message; that is what gets classified. */
export function extractObjective(messages: ChatMessage[] | undefined): string {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role !== "user") continue;
    const text = flattenContent(message.content);
    if (text.trim()) return text.slice(0, MAX_OBJECTIVE_CHARS);
  }
  return "";
}

export function flattenContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      const value = (part as { text?: unknown })?.text;
      return typeof value === "string" ? value : "";
    })
    .filter(Boolean)
    .join("\n");
}

/**
 * Rewrite an incoming request to target the routed model. Everything else —
 * tools, schema, message history — is the caller's and passes through untouched.
 */
export function rewriteRequest(
  body: ChatRequest,
  routed: ModelCapabilities,
): { body: ChatRequest; objective: string } {
  const objective = extractObjective(body.messages);
  return {
    body: { ...body, model: routed.id },
    objective,
  };
}

/** Model list for /v1/models. Tools that probe the endpoint need this. */
export function modelList(models: Array<{ id: string; provider?: string; displayName?: string }>) {
  return {
    object: "list",
    data: [
      { id: "switchyard/auto", object: "model", owned_by: "switchyard" },
      ...models.map((m) => ({
        id: m.id,
        object: "model",
        owned_by: m.provider ?? "switchyard",
      })),
    ],
  };
}
