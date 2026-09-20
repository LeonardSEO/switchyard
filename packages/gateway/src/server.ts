import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import {
  defaultClassifierFloors,
  DecisionClassifier,
  KeywordClassifier,
  keywordClassification,
  rankClassifierCandidates,
  ModelClassifier,
  route,
  type Classification,
  type Classifier,
  type DecisionFn,
  attributionHeaders,
  type Attribution,
  type CapacityState,
  type ModelCapabilities,
} from "@vepando/switchyard-core";
import { buildSnapshot, executeCodexRequest } from "@vepando/switchyard-catalog";
import {
  createOpenRouterCompletion,
  createOpenRouterDecision,
  OPENROUTER_JEV_LATEST,
} from "@vepando/switchyard-provider-openrouter";
import {
  extractObjective,
  modelList,
  requiresApiExecution,
  rewriteRequest,
  type ChatRequest,
} from "./router.js";

export interface GatewayOptions {
  port?: number;
  host?: string;
  /** Upstream for executed requests. Defaults to OpenRouter. */
  upstreamBaseUrl?: string;
  apiKey?: string;
  /** Pin only the chat-model fallback used when Jev cannot classify. */
  classifierModel?: string;
  /** Compatible OpenRouter Decisions endpoint override. */
  decisionsBaseUrl?: string;
  /** Inject the decision transport for tests or embedding. */
  decisionFn?: DecisionFn;
  /** Skip AI classification and use the deterministic path. */
  escalation?: "always" | "uncertain" | "never";
  freshnessMs?: number;
  now?: () => number;
  /** Inject the model pool (tests, offline use) instead of fetching it. */
  models?: ModelCapabilities[];
  capacity?: Record<string, CapacityState>;
  /** Override the default OpenRouter app attribution. */
  attribution?: Attribution;
  /** Execute a subscription-routed request (injectable for tests). */
  executeSubscription?: (
    messages: Array<{ role?: string; content?: unknown }>,
    model: ModelCapabilities,
    request?: ChatRequest,
  ) => Promise<{ text: string }>;
}

const DEFAULT_FRESHNESS_MS = 10 * 60 * 1000;

export interface Gateway {
  port: number;
  close: () => Promise<void>;
  handle: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
}

/**
 * Minimal OpenAI-compatible gateway. It does not become the agent: it answers
 * "which model should run this request" and forwards everything else untouched.
 */
export async function createGateway(opts: GatewayOptions = {}): Promise<Gateway> {
  const upstream = (opts.upstreamBaseUrl ?? "https://openrouter.ai/api/v1").replace(/\/$/, "");
  const freshnessMs = opts.freshnessMs ?? DEFAULT_FRESHNESS_MS;
  const now = opts.now ?? Date.now;

  let loadedAt = 0;
  let models: ModelCapabilities[] = [];
  let capacity: Record<string, CapacityState> = {};
  let classifier: Classifier | undefined;

  const buildClassifier = (available: ModelCapabilities[]): Classifier => {
    const keyword = new KeywordClassifier();
    const escalation = opts.escalation ?? "always";
    if (escalation === "never") return keyword;

    const api = available.filter((model) => model.pricing.kind === "api");
    const floors = {
      ...defaultClassifierFloors,
      minCapabilityScore: 0.5,
      allowReasoning: true,
    };
    const ranked = rankClassifierCandidates(api, floors, 5);
    const pinned = opts.classifierModel
      ? api.find((model) => model.id === opts.classifierModel)
      : undefined;
    const picked = pinned ?? ranked[0];
    let fallback: Classifier = keyword;

    if (picked) {
      const ordered = [picked, ...ranked.filter((model) => model.id !== picked.id)];
      const transport = createOpenRouterCompletion({
        apiKey: opts.apiKey,
        baseUrl: upstream,
        attribution: opts.attribution,
      });
      const complete = async (request: Parameters<typeof transport>[0]) => {
        let lastError: unknown;
        for (const candidate of ordered) {
          try {
            return await transport({ ...request, model: candidate });
          } catch (error) {
            lastError = error;
          }
        }
        throw lastError instanceof Error
          ? lastError
          : new Error("classifier unavailable");
      };
      fallback = new ModelClassifier({
        models: api,
        modelId: picked.id,
        complete,
        escalation: "always",
        minSavingsFactor: 0,
      });
    }

    const decide =
      opts.decisionFn ??
      (opts.models && !opts.decisionsBaseUrl
        ? undefined
        : createOpenRouterDecision({
            apiKey: opts.apiKey,
            baseUrl: upstream,
            decisionsBaseUrl: opts.decisionsBaseUrl,
            appUrl: opts.attribution?.referer,
            appTitle: opts.attribution?.title,
          }));
    if (!decide) return keyword;

    return new DecisionClassifier({
      model: OPENROUTER_JEV_LATEST,
      decide,
      fallback,
      escalation,
      now,
    });
  };

  const refresh = async (force = false) => {
    if (!force && models.length > 0 && now() - loadedAt < freshnessMs) return;
    if (opts.models) {
      models = opts.models;
      capacity = opts.capacity ?? {};
      loadedAt = now();
      classifier = buildClassifier(models);
      return;
    }
    const snapshot = await buildSnapshot();
    models = snapshot.models;
    capacity = snapshot.capacity;
    loadedAt = now();

    classifier = buildClassifier(models);
  };

  const classify = async (objective: string): Promise<Classification> => {
    if (!classifier) return keywordClassification({ objective });
    return classifier.classify({ objective });
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (url.pathname === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, models: models.length, loadedAt }));
      return;
    }

    if (url.pathname === "/v1/models" && req.method === "GET") {
      await refresh();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(modelList(models)));
      return;
    }

    if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
      const raw = await readBody(req);
      let body: ChatRequest;
      try {
        body = JSON.parse(raw) as ChatRequest;
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "invalid JSON body" } }));
        return;
      }

      await refresh();
      const objective = extractObjective(body.messages) || "coding task";
      const classification = await classify(objective);
      const candidates = requiresApiExecution(body)
        ? models.filter((model) => model.pricing.kind === "api")
        : models;
      let decision = route({ objective }, candidates, classification, { capacity });

      if (!decision.model) {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            error: { message: `switchyard: no viable model for ${decision.complexity}` },
          }),
        );
        return;
      }

      if (url.searchParams.has("explain") || body.model === "switchyard/explain") {
        sendExplanation(res, decision, classification);
        return;
      }

      // Subscription capacity runs on the Codex backend, not upstream.
      if (decision.model.pricing.kind === "subscription") {
        const run =
          opts.executeSubscription ??
          ((_messages, model, request) =>
            executeCodexRequest(request ?? { messages: _messages }, model));
        try {
          const result = await run(body.messages ?? [], decision.model, body);
          const payload = completion(body, decision.model, result.text);
          res.writeHead(200, {
            "content-type": body.stream ? "text/event-stream" : "application/json",
            "x-switchyard-model": decision.model.id,
            "x-switchyard-complexity": decision.complexity,
          });
          res.end(body.stream ? streamCompletion(payload, result.text) : JSON.stringify(payload));
          return;
        } catch (err) {
          // Fail over to API routing rather than break the turn.
          console.warn(`[switchyard] codex execution failed: ${(err as Error).message}`);
          decision = route(
            { objective, skipModels: [decision.model.id] },
            models.filter((model) => model.pricing.kind === "api"),
            classification,
            { capacity },
          );
          if (!decision.model) {
            res.writeHead(503, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: { message: "switchyard: Codex failed and no API fallback is available" } }));
            return;
          }
        }
      }

      const { body: forwarded } = rewriteRequest(body, decision.model);

      const upstreamRes = await fetch(`${upstream}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}),
          ...attributionHeaders(opts.attribution ?? {}),
        },
        body: JSON.stringify(forwarded),
      });

      res.writeHead(upstreamRes.status, {
        "content-type":
          upstreamRes.headers.get("content-type") ?? "application/json",
        "x-switchyard-model": decision.model.id,
        "x-switchyard-complexity": decision.complexity,
      });

      if (upstreamRes.body) {
        Readable.fromWeb(upstreamRes.body as never).pipe(res);
      } else {
        res.end(await upstreamRes.text());
      }
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "not found" } }));
  };

  const server = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: (err as Error).message } }));
    });
  });

  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, opts.host ?? "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : (opts.port ?? 0);

  return {
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    handle,
  };
}

function completion(
  body: ChatRequest,
  model: ModelCapabilities,
  text: string,
) {
  return {
    id: `chatcmpl-switchyard-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: model.id,
    choices: [
      { index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" },
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

function sendExplanation(
  res: ServerResponse,
  decision: ReturnType<typeof route>,
  classification: Classification,
): void {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      model: decision.model?.id ?? null,
      complexity: decision.complexity,
      kind: decision.kind,
      effort: decision.effort,
      classifier: classification.source,
      candidates: decision.ranked.length,
    }),
  );
}

function streamCompletion(payload: ReturnType<typeof completion>, text: string): string {
  const base = {
    id: payload.id,
    object: "chat.completion.chunk",
    created: payload.created,
    model: payload.model,
  };
  const content = {
    ...base,
    choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
  };
  const finished = {
    ...base,
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  };
  return `data: ${JSON.stringify(content)}\n\ndata: ${JSON.stringify(finished)}\n\ndata: [DONE]\n\n`;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}
