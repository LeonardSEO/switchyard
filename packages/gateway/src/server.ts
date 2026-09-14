import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import {
  defaultClassifierFloors,
  keywordClassification,
  rankClassifierCandidates,
  ModelClassifier,
  pickCheapestClassifier,
  route,
  type Classification,
  type Classifier,
  attributionHeaders,
  type Attribution,
  type CapacityState,
  type ModelCapabilities,
} from "@vepando/switchyard-core";
import { buildSnapshot, executeCodex } from "@vepando/switchyard-catalog";
import { createOpenRouterCompletion } from "@vepando/switchyard-provider-openrouter";
import { extractObjective, modelList, rewriteRequest, type ChatRequest } from "./router.js";

export interface GatewayOptions {
  port?: number;
  host?: string;
  /** Upstream for executed requests. Defaults to OpenRouter. */
  upstreamBaseUrl?: string;
  apiKey?: string;
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

  const refresh = async (force = false) => {
    if (!force && models.length > 0 && now() - loadedAt < freshnessMs) return;
    if (opts.models) {
      models = opts.models;
      capacity = opts.capacity ?? {};
      loadedAt = now();
      classifier = undefined;
      return;
    }
    const snapshot = await buildSnapshot();
    models = snapshot.models;
    capacity = snapshot.capacity;
    loadedAt = now();

    const api = models.filter((m) => m.pricing.kind === "api");
    const floors = {
      ...defaultClassifierFloors,
      // Below ~0.5 models guess instead of following the schema, and the rung
      // decides everything downstream.
      minCapabilityScore: 0.5,
      allowReasoning: true,
    };
    const ranked = rankClassifierCandidates(api, floors, 3);
    const picked = ranked[0];
    const transport = createOpenRouterCompletion({ apiKey: opts.apiKey });
    // Fall through to the next candidate on failure: one dead catalog entry
    // must not cost every request its classification.
    const complete = ranked.length > 1
      ? async (req: Parameters<typeof transport>[0]) => {
          let lastError: unknown;
          for (const candidate of ranked) {
            try {
              return await transport({ ...req, model: candidate });
            } catch (err) {
              lastError = err;
            }
          }
          throw lastError instanceof Error ? lastError : new Error("classifier unavailable");
        }
      : transport;
    classifier = picked
      ? new ModelClassifier({
          models: api,
          modelId: picked.id,
          complete,
          escalation: opts.escalation ?? "always",
          minSavingsFactor: 0,
        })
      : undefined;
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
      const decision = route({ objective }, models, classification, { capacity });

      if (!decision.model) {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            error: { message: `switchyard: no viable model for ${decision.complexity}` },
          }),
        );
        return;
      }

      // Subscription capacity runs on the Codex backend, not upstream.
      if (decision.model.pricing.kind === "subscription") {
        const run = opts.executeSubscription ?? executeCodex;
        try {
          const result = await run(body.messages ?? [], decision.model);
          const payload = completion(body, decision.model, result.text);
          res.writeHead(200, {
            "content-type": body.stream ? "text/event-stream" : "application/json",
            "x-switchyard-model": decision.model.id,
            "x-switchyard-complexity": decision.complexity,
          });
          res.end(
            body.stream
              ? `data: ${JSON.stringify({ ...payload, object: "chat.completion.chunk" })}\n\ndata: [DONE]\n\n`
              : JSON.stringify(payload),
          );
          return;
        } catch (err) {
          // Fail over to API routing rather than break the turn.
          console.warn(`[switchyard] codex execution failed: ${(err as Error).message}`);
        }
      }

      const { body: forwarded } = rewriteRequest(body, decision.model);

      if (url.searchParams.has("explain") || body.model === "switchyard/explain") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            model: decision.model.id,
            complexity: decision.complexity,
            kind: decision.kind,
            effort: decision.effort,
            classifier: classification.source,
            candidates: decision.ranked.length,
          }),
        );
        return;
      }

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
    model: body.model ?? model.id,
    choices: [
      { index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" },
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}
