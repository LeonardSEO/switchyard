import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type {
  DecisionRequest,
  DecisionResponse,
  ModelCapabilities,
} from "@vepando/switchyard-core";
import { createGateway } from "../src/index.js";
import { extractObjective, modelList, requiresApiExecution, rewriteRequest } from "../src/index.js";

const model = (id: string, price: number, capability: number): ModelCapabilities => ({
  id,
  provider: "openrouter",
  tier: capability >= 0.6 ? "large" : "mid",
  capabilityScore: capability,
  maxContextTokens: 100_000,
  capabilities: { structuredOutput: true, toolCalling: true },
  pricing: {
    kind: "api",
    inputPer1M: { known: true, value: price },
    outputPer1M: { known: true, value: price * 4 },
  },
});

const pool = [
  model("cheap/flash", 0.02, 0.52),
  model("mid/flash", 0.15, 0.71),
  model("frontier/large", 3, 0.8),
];

function decisionResponse(
  request: DecisionRequest,
  kind: string,
  complexity: string,
  confidence = 0.9,
): DecisionResponse {
  const answers: DecisionResponse["answers"] = {};
  if (request.questions.task_kind) {
    answers.task_kind = {
      type: "choice",
      choice: kind,
      probabilities: { [kind]: confidence },
      confidence,
    };
  }
  if (request.questions.task_complexity) {
    answers.task_complexity = {
      type: "choice",
      choice: complexity,
      probabilities: { [complexity]: confidence },
      confidence,
    };
  }
  return { model: "typesafe/jev-1.13-20260917", answers };
}

async function explain(
  target: Awaited<ReturnType<typeof createGateway>>,
  objective: string,
  fetchFn: typeof fetch = fetch,
): Promise<{ model: string | null; complexity: string; classifier: string }> {
  const response = await fetchFn(
    `http://127.0.0.1:${target.port}/v1/chat/completions?explain=1`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "switchyard/auto",
        messages: [{ role: "user", content: objective }],
      }),
    },
  );
  return response.json() as Promise<{
    model: string | null;
    complexity: string;
    classifier: string;
  }>;
}

describe("gateway routing helpers", () => {
  it("takes the objective from the last user message", () => {
    expect(
      extractObjective([
        { role: "system", content: "you are helpful" },
        { role: "user", content: "first question" },
        { role: "assistant", content: "an answer" },
        { role: "user", content: [{ type: "text", text: "the real task" }] },
      ]),
    ).toBe("the real task");
  });

  it("rewrites the model and leaves the rest of the request alone", () => {
    const body = { model: "switchyard/auto", messages: [{ role: "user", content: "hi" }], temperature: 0 };
    const { body: forwarded, objective } = rewriteRequest(body, pool[1]);
    expect(forwarded.model).toBe("mid/flash");
    expect(forwarded.temperature).toBe(0);
    expect(forwarded.messages).toEqual(body.messages);
    expect(objective).toBe("hi");
  });

  it("advertises switchyard/auto plus the catalog", () => {
    const list = modelList(pool);
    expect(list.data[0].id).toBe("switchyard/auto");
    expect(list.data).toHaveLength(pool.length + 1);
  });

  it("keeps tool-bearing requests on an API execution path", () => {
    expect(
      requiresApiExecution({
        messages: [{ role: "user", content: "run a tool" }],
        tools: [{ type: "function", function: { name: "shell" } }],
      }),
    ).toBe(true);
    expect(
      requiresApiExecution({
        messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "x" } }] }],
      }),
    ).toBe(true);
    expect(
      requiresApiExecution({
        messages: [{ role: "user", content: "structured" }],
        response_format: { type: "json_object" },
      }),
    ).toBe(true);
    expect(requiresApiExecution({ messages: [{ role: "system", content: "rules" }] })).toBe(false);
  });
});

let gateway: Awaited<ReturnType<typeof createGateway>> | undefined;
let upstream: Server | undefined;
const servers: Server[] = [];

afterEach(async () => {
  await gateway?.close();
  gateway = undefined;
  for (const s of servers) await new Promise<void>((r) => s.close(() => r()));
  servers.length = 0;
});

describe("gateway server", () => {
  it("routes a request to a real model and forwards it upstream", async () => {
    const seen: Array<{ model?: string; auth?: string }> = [];
    upstream = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        seen.push({ model: JSON.parse(raw).model, auth: req.headers.authorization });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
      });
    });
    await new Promise<void>((r) => upstream!.listen(0, "127.0.0.1", r));
    servers.push(upstream);
    const port = (upstream.address() as { port: number }).port;

    gateway = await createGateway({
      models: pool,
      upstreamBaseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: "test-key",
    });

    const res = await fetch(`http://127.0.0.1:${gateway.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "switchyard/auto",
        messages: [{ role: "user", content: "Rewrite the billing service from scratch as a scalable event-driven system" }],
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("x-switchyard-model")).toBeTruthy();
    expect(res.headers.get("x-switchyard-complexity")).toBeTruthy();
    expect(seen[0].model).not.toBe("switchyard/auto");
    expect(seen[0].auth).toBe("Bearer test-key");
    await res.json();
  });

  it("serves /v1/models and /healthz", async () => {
    gateway = await createGateway({ models: pool });
    const models = await fetch(`http://127.0.0.1:${gateway.port}/v1/models`).then((r) => r.json());
    expect((models as { data: unknown[] }).data.length).toBe(pool.length + 1);
    const health = await fetch(`http://127.0.0.1:${gateway.port}/healthz`).then((r) => r.json());
    expect((health as { ok: boolean }).ok).toBe(true);
  });

  it("fails closed with a clear error when nothing is viable", async () => {
    gateway = await createGateway({ models: [] });
    const res = await fetch(`http://127.0.0.1:${gateway.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "switchyard/auto", messages: [{ role: "user", content: "do something" }] }),
    });
    expect(res.status).toBe(503);
  });
});

describe("Jev-first gateway classification", () => {
  it("routes from an injected Jev classification", async () => {
    const decisionFn = vi.fn(async (request: DecisionRequest) =>
      decisionResponse(request, "code-change", "advanced", 0.9),
    );
    gateway = await createGateway({ models: pool, decisionFn });

    const result = await explain(gateway, "Implement cross-package retries");

    expect(decisionFn).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      model: "mid/flash",
      complexity: "advanced",
      classifier: "jev",
    });
  });

  it("uses the pinned chat classifier only after Jev fails", async () => {
    const originalFetch = globalThis.fetch;
    const bodies: Array<{ model: string }> = [];
    globalThis.fetch = vi.fn(async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as { model: string });
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: '{"kind":"code-change","complexity":"advanced","confidence":0.9}',
              },
            },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 20 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    gateway = await createGateway({
      models: pool,
      apiKey: "test-key",
      classifierModel: "mid/flash",
      decisionFn: async () => {
        throw new Error("Jev unavailable");
      },
    });

    try {
      const result = await explain(gateway, "Implement cross-package retries", originalFetch);
      expect(result.classifier).toBe("model");
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.model).toBe("mid/flash");
  });

  it("falls through Jev and chat failures to keyword classification", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => new Response("", { status: 503 })) as typeof fetch;
    gateway = await createGateway({
      models: pool,
      apiKey: "test-key",
      decisionFn: async () => {
        throw new Error("Jev unavailable");
      },
    });

    try {
      const result = await explain(gateway, "Implement cross-package retries", originalFetch);
      expect(result.classifier).toBe("keyword");
      expect(result.model).toBeTruthy();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("makes no remote classifier call when escalation is never", async () => {
    const decisionFn = vi.fn();
    const originalFetch = globalThis.fetch;
    const remoteFetch = vi.fn<typeof fetch>();
    globalThis.fetch = remoteFetch;
    gateway = await createGateway({
      models: pool,
      escalation: "never",
      decisionFn,
    });

    try {
      const result = await explain(gateway, "Implement cross-package retries", originalFetch);
      expect(result.classifier).toBe("keyword");
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(decisionFn).not.toHaveBeenCalled();
    expect(remoteFetch).not.toHaveBeenCalled();
  });

  it("uses an explicit compatible Decisions endpoint", async () => {
    const originalFetch = globalThis.fetch;
    const urls: string[] = [];
    globalThis.fetch = vi.fn(async (url, init) => {
      urls.push(String(url));
      const request = JSON.parse(String(init?.body)) as DecisionRequest;
      return new Response(
        JSON.stringify(decisionResponse(request, "review", "simple")),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    gateway = await createGateway({
      models: pool,
      apiKey: "test-key",
      decisionsBaseUrl: "https://decisions.example.test/v2/classify",
    });

    try {
      await explain(gateway, "Review this parser patch", originalFetch);
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(urls).toEqual(["https://decisions.example.test/v2/classify"]);
  });
});

describe("openrouter attribution", () => {
  it("sends X-Title and HTTP-Referer upstream on every request", async () => {
    const seen: Array<{ title?: string; referer?: string }> = [];
    const echo = createServer((req, res) => {
      seen.push({
        title: req.headers["x-title"] as string | undefined,
        referer: req.headers["http-referer"] as string | undefined,
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
    });
    await new Promise<void>((r) => echo.listen(0, "127.0.0.1", r));
    servers.push(echo);
    const port = (echo.address() as { port: number }).port;

    gateway = await createGateway({
      models: pool,
      upstreamBaseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: "k",
    });
    await fetch(`http://127.0.0.1:${gateway.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "switchyard/auto",
        messages: [{ role: "user", content: "Fix the typo in the README" }],
      }),
    }).then((r) => r.json());

    expect(seen[0].title).toBeTruthy();
    expect(seen[0].referer).toContain("github.com");
  });
});

describe("subscription capacity in the gateway", () => {
  it("runs a subscription-routed request on the Codex backend, not upstream", async () => {
    let upstreamHits = 0;
    const echo = createServer((_req, res) => {
      upstreamHits += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "from upstream" } }] }));
    });
    await new Promise<void>((r) => echo.listen(0, "127.0.0.1", r));
    servers.push(echo);
    const port = (echo.address() as { port: number }).port;

    const sol: ModelCapabilities = {
      id: "codex-sol",
      provider: "codex-subscription",
      tier: "large",
      capabilityScore: 0.774,
      maxContextTokens: 400_000,
      pricing: {
        kind: "subscription",
        inputPer1M: { known: false },
        outputPer1M: { known: false },
        planAmortizedPer1M: { known: true, value: 0.5 },
      },
    };

    gateway = await createGateway({
      models: [...pool, sol],
      upstreamBaseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: "k",
      executeSubscription: async () => ({ text: "from subscription" }),
    });

    const res = await fetch(`http://127.0.0.1:${gateway.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "switchyard/auto",
        messages: [{ role: "user", content: "Rewrite the billing service from scratch as a scalable event-driven system" }],
      }),
    });
    const json = (await res.json()) as { choices: Array<{ message: { content: string } }> };
    expect(res.headers.get("x-switchyard-model")).toBe("codex-sol");
    expect(json.choices[0].message.content).toBe("from subscription");
    expect(upstreamHits).toBe(0);
  });

  it("fails over to API routing when the Codex backend errors", async () => {
    const forwardedModels: string[] = [];
    const echo = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => forwardedModels.push((JSON.parse(raw) as { model: string }).model));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "from upstream" } }] }));
    });
    await new Promise<void>((r) => echo.listen(0, "127.0.0.1", r));
    servers.push(echo);
    const port = (echo.address() as { port: number }).port;

    const sol: ModelCapabilities = {
      id: "codex-sol",
      provider: "codex-subscription",
      tier: "large",
      capabilityScore: 0.774,
      pricing: {
        kind: "subscription",
        inputPer1M: { known: false },
        outputPer1M: { known: false },
        planAmortizedPer1M: { known: true, value: 0.5 },
      },
    };

    gateway = await createGateway({
      models: [...pool, sol],
      upstreamBaseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: "k",
      executeSubscription: async () => {
        throw new Error("codex backend 500");
      },
    });

    const res = await fetch(`http://127.0.0.1:${gateway.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "switchyard/auto",
        messages: [{ role: "user", content: "Rewrite the billing service from scratch as a scalable event-driven system" }],
      }),
    });
    const json = (await res.json()) as { choices: Array<{ message: { content: string } }> };
    expect(res.status).toBe(200);
    expect(json.choices[0].message.content).toBe("from upstream");
    expect(forwardedModels).toHaveLength(1);
    expect(forwardedModels[0]).not.toBe("codex-sol");
    expect(res.headers.get("x-switchyard-model")).toBe(forwardedModels[0]);
  });

  it("explains a subscription decision without executing it", async () => {
    let executions = 0;
    const sol: ModelCapabilities = {
      ...model("codex-sol", 0.5, 0.8),
      provider: "codex-subscription",
      pricing: {
        kind: "subscription",
        inputPer1M: { known: false },
        outputPer1M: { known: false },
        planAmortizedPer1M: { known: true, value: 0.5 },
      },
    };
    gateway = await createGateway({
      models: [...pool, sol],
      capacity: {
        "codex-sol": {
          available: true,
          usage: { remainingFraction: 0.9, windowElapsedFraction: 0.1, source: "test" },
        },
      },
      executeSubscription: async () => {
        executions += 1;
        return { text: "should not run" };
      },
    });

    const res = await fetch(`http://127.0.0.1:${gateway.port}/v1/chat/completions?explain=1`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "switchyard/auto",
        messages: [{ role: "user", content: "Rewrite the billing service from scratch as a scalable event-driven system" }],
      }),
    });
    const json = (await res.json()) as { model: string };
    expect(json.model).toBe("codex-sol");
    expect(executions).toBe(0);
  });

  it("returns valid OpenAI streaming chunks for subscription text", async () => {
    const sol: ModelCapabilities = {
      ...model("codex-sol", 0.5, 0.8),
      provider: "codex-subscription",
      pricing: {
        kind: "subscription",
        inputPer1M: { known: false },
        outputPer1M: { known: false },
        planAmortizedPer1M: { known: true, value: 0.5 },
      },
    };
    gateway = await createGateway({
      models: [...pool, sol],
      capacity: {
        "codex-sol": {
          available: true,
          usage: { remainingFraction: 0.9, windowElapsedFraction: 0.1, source: "test" },
        },
      },
      executeSubscription: async () => ({ text: "streamed" }),
    });

    const text = await fetch(`http://127.0.0.1:${gateway.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "switchyard/auto",
        stream: true,
        messages: [{ role: "user", content: "Rewrite the billing service from scratch as a scalable event-driven system" }],
      }),
    }).then((response) => response.text());

    const events = text
      .split("\n\n")
      .filter((line) => line.startsWith("data: {") )
      .map((line) => JSON.parse(line.slice(6)) as { choices: Array<{ delta: { content?: string } }> });
    expect(events[0].choices[0].delta.content).toBe("streamed");
    expect(text).not.toContain('"message"');
    expect(text).toContain("data: [DONE]");
  });
});
