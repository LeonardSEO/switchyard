import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { ModelCapabilities } from "@vepando/switchyard-core";
import { createGateway } from "../src/index.js";
import { extractObjective, modelList, rewriteRequest } from "../src/index.js";

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
    const echo = createServer((_req, res) => {
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
  });
});
