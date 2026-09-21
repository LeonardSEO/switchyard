import {
  attributionHeaders,
  type DecisionChoiceAnswer,
  type DecisionFn,
  type DecisionResponse,
} from "@vepando/switchyard-core";

export const OPENROUTER_JEV_LATEST = "~typesafe/jev-latest";

const DEFAULT_DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";

export interface ResolvedOpenRouterAuth {
  apiKey?: string;
  headers?: Record<string, string>;
  baseUrl?: string;
}

export interface OpenRouterDecisionOptions extends ResolvedOpenRouterAuth {
  decisionsBaseUrl?: string;
  resolveAuth?: () => Promise<ResolvedOpenRouterAuth | undefined>;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  appUrl?: string;
  appTitle?: string;
}

export function createOpenRouterDecision(
  options: OpenRouterDecisionOptions = {},
): DecisionFn {
  const timeoutMs = options.timeoutMs ?? 20_000;

  return async (request): Promise<DecisionResponse> => {
    const resolved = (await options.resolveAuth?.()) ?? {};
    const apiKey = resolved.apiKey ?? options.apiKey;
    if (!apiKey) {
      throw new Error("OpenRouter Decisions credential is unavailable");
    }

    const fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);
    const headers: Record<string, string> = {
      ...safeCustomHeaders(options.headers),
      ...safeCustomHeaders(resolved.headers),
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      ...attributionHeaders({ referer: options.appUrl, title: options.appTitle }),
    };
    const url = decisionsUrl(
      options.decisionsBaseUrl,
      resolved.baseUrl,
      options.baseUrl,
    );
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetchFn(url, {
        method: "POST",
        headers,
        signal: controller.signal,
        body: JSON.stringify(request),
      });
      if (!response.ok) {
        throw new Error(`OpenRouter Decisions request failed with status ${response.status}`);
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new Error("OpenRouter Decisions returned invalid JSON");
      }
      return parseDecisionResponse(body);
    } finally {
      clearTimeout(timer);
    }
  };
}

function safeCustomHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> {
  if (!headers) return {};
  const protectedNames = new Set([
    "authorization",
    "content-type",
    "http-referer",
    "x-title",
  ]);
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => !protectedNames.has(name.toLowerCase())),
  );
}

function decisionsUrl(
  explicit: string | undefined,
  resolvedBaseUrl: string | undefined,
  staticBaseUrl: string | undefined,
): string {
  if (explicit) return explicit.replace(/\/$/, "");
  return (
    deriveDecisionsUrl(resolvedBaseUrl) ??
    deriveDecisionsUrl(staticBaseUrl) ??
    DEFAULT_DECISIONS_URL
  );
}

function deriveDecisionsUrl(baseUrl: string | undefined): string | undefined {
  if (!baseUrl) return undefined;
  const normalized = baseUrl.replace(/\/$/, "");
  if (!normalized.endsWith("/api/v1")) return undefined;
  return `${normalized.slice(0, -"/api/v1".length)}/api/alpha/decisions`;
}

function parseDecisionResponse(value: unknown): DecisionResponse {
  if (!isRecord(value) || typeof value.model !== "string" || !isRecord(value.answers)) {
    throw new Error("OpenRouter Decisions returned a malformed response");
  }
  const usage = isRecord(value.usage) ? value.usage : undefined;
  const cost = usage?.cost;
  return {
    model: value.model,
    answers: value.answers as Record<string, DecisionChoiceAnswer>,
    ...(typeof cost === "number" && Number.isFinite(cost) && cost >= 0
      ? { costUsd: cost }
      : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
