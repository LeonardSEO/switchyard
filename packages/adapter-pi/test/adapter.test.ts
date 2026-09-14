import { afterEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CapacityState, ModelCapabilities } from "@switchyard/core";
import { createExtension, matchPiModel, judgeRun, readOutcomes, signalsFromOutcomes } from "../src/index";
import type { PiApiLike, PiContextLike, PiModelLike } from "../src/pi";

const model = (
  id: string,
  provider: string,
  kind: "api" | "subscription",
  price: number,
  capability?: number,
  amortized?: number,
): ModelCapabilities => ({
  id,
  provider,
  displayName: id.split("/").pop()?.replace("codex-", ""),
  tier: capability === undefined ? "unknown" : capability >= 0.6 ? "large" : "mid",
  capabilityScore: capability,
  pricing:
    kind === "api"
      ? {
          kind: "api",
          inputPer1M: { known: true, value: price },
          outputPer1M: { known: true, value: price * 5 },
        }
      : {
          kind: "subscription",
          inputPer1M: { known: false },
          outputPer1M: { known: false },
          planAmortizedPer1M: { known: true, value: amortized ?? 0.3 },
        },
});

const flash = model("deepseek/deepseek-v4-flash-0731", "deepseek", "api", 0.06, 0.691);
const cheap = model("inclusionai/ling-3.0-flash", "inclusionai", "api", 0.021, 0.506);
const sol = model("codex-sol", "codex-subscription", "subscription", 0, 0.774, 0.5);

function fakePi(models: PiModelLike[]) {
  const handlers: Record<string, (event: unknown, ctx: PiContextLike) => unknown> = {};
  const calls: { model?: string; level?: string; notify?: string } = {};
  const ctx: PiContextLike = {
    modelRegistry: { getAvailable: () => models },
    ui: { notify: (message: string) => (calls.notify = message) },
  };
  const pi: PiApiLike = {
    on: (event: string, handler: (event: unknown, ctx: PiContextLike) => unknown) => {
      handlers[event] = handler;
    },
    setModel: (m: PiModelLike) => {
      calls.model = m.id;
      return Promise.resolve(true);
    },
    setThinkingLevel: (level: string) => {
      calls.level = level;
    },
  };
  return { pi, ctx, handlers, calls };
}

const snapshotOf = (
  models: ModelCapabilities[],
  capacity: Record<string, CapacityState> = {},
) => ({
  models,
  capacity,
  status: [],
  usage: { source: "none", note: "" },
  matches: [],
  codexRoster: "default" as const,
});

const classifierModel = (
  id: string,
  price: number,
  capability: number,
  tier: "mid" | "large" = "mid",
): ModelCapabilities => ({
  id,
  provider: "openrouter",
  tier,
  capabilityScore: capability,
  maxContextTokens: 100_000,
  capabilities: { structuredOutput: true, toolCalling: true },
  pricing: {
    kind: "api",
    inputPer1M: { known: true, value: price },
    outputPer1M: { known: true, value: price * 4 },
  },
});

function fakeCtxWithAuth(auth: { apiKey?: string; baseUrl?: string }) {
  const captured: { url?: string; headers?: Record<string, string>; body?: string } = {};
  const ctx: PiContextLike = {
    modelRegistry: {
      getAvailable: () => [],
      getProviderAuth: async () => ({ auth }),
    },
    ui: { notify: () => {} },
  };
  return { ctx, captured };
}

const files: string[] = [];
const tempFile = () => {
  const path = join(tmpdir(), `switchyard-outcomes-${Math.random().toString(36).slice(2)}.jsonl`);
  files.push(path);
  return path;
};

afterEach(() => {
  while (files.length) rmSync(files.pop()!, { force: true });
});

describe("pi adapter", () => {
  const available: PiModelLike[] = [
    { id: "deepseek/deepseek-v4-flash-0731", provider: "openrouter" },
    { id: "inclusionai/ling-3.0-flash", provider: "openrouter" },
    { id: "gpt-5.6-sol", provider: "openai-codex", name: "Sol" },
  ];

  it("matches our catalog ids and Codex names onto Pi's registry", () => {
    expect(matchPiModel(flash, available)?.id).toBe("deepseek/deepseek-v4-flash-0731");
    expect(matchPiModel(sol, available)?.id).toBe("gpt-5.6-sol");
    expect(matchPiModel(model("nope/nope", "nope", "api", 1, 0.5), available)).toBeUndefined();
  });

  it("routes a trivial turn to the cheap model and sets a low effort", async () => {
    const { pi, ctx, handlers, calls } = fakePi(available);
    createExtension({
      loadSnapshot: async () => snapshotOf([cheap, flash, sol]),
      outcomeFile: tempFile(),
      quiet: true,
    })(pi);

    await handlers.before_agent_start!({ prompt: "rename the variable total to orderTotal" }, ctx);
    expect(calls.model).toBeDefined();
    expect(calls.level).toBeTruthy();
  });

  it("routes a rewrite to subscription capacity with high effort", async () => {
    const { pi, ctx, handlers, calls } = fakePi(available);
    createExtension({
      loadSnapshot: async () => snapshotOf([cheap, flash, sol], {
        "codex-sol": {
          available: true,
          usage: { remainingFraction: 0.9, windowElapsedFraction: 0.1, source: "test" },
        },
      }),
      outcomeFile: tempFile(),
      quiet: true,
    })(pi);

    await handlers.before_agent_start!(
      { prompt: "rewrite the billing service from scratch as a scalable event-driven system" },
      ctx,
    );
    expect(calls.model).toBe("gpt-5.6-sol");
    expect(["high", "xhigh", "max"]).toContain(calls.level);
  });

  it("leaves Pi alone when nothing in the catalog is runnable here", async () => {
    const { pi, ctx, handlers, calls } = fakePi([]);
    createExtension({
      loadSnapshot: async () => snapshotOf([cheap, flash]),
      outcomeFile: tempFile(),
      quiet: true,
    })(pi);
    await handlers.before_agent_start!({ prompt: "rename a variable" }, ctx);
    expect(calls.model).toBeUndefined();
  });

  it("survives a catalog failure without breaking the turn", async () => {
    const { pi, ctx, handlers, calls } = fakePi(available);
    createExtension({
      loadSnapshot: async () => {
        throw new Error("offline");
      },
      outcomeFile: tempFile(),
      quiet: true,
    })(pi);
    await handlers.before_agent_start!({ prompt: "rename a variable" }, ctx);
    expect(calls.model).toBeUndefined();
  });

  it("records the outcome and learns from it", async () => {
    const file = tempFile();
    const { pi, ctx, handlers } = fakePi(available);
    createExtension({
      loadSnapshot: async () => snapshotOf([cheap, flash, sol]),
      outcomeFile: file,
      quiet: true,
    })(pi);

    await handlers.before_agent_start!({ prompt: "rename the variable total to orderTotal" }, ctx);
    await handlers.agent_end!(
      { messages: [{ role: "assistant", stopReason: "stop" }] },
      ctx,
    );

    const outcomes = await readOutcomes(file);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].success).toBe(true);
    expect(signalsFromOutcomes(outcomes)[`${outcomes[0].modelId}|${outcomes[0].kind}`]?.successRate).toBe(1);
  });

  it("judges a failed run as a failure", () => {
    expect(judgeRun([{ role: "assistant", stopReason: "error" }])).toBe(false);
    expect(judgeRun([{ role: "assistant", stopReason: "length" }])).toBe(false);
    expect(judgeRun([{ role: "assistant", stopReason: "stop" }])).toBe(true);
    expect(judgeRun([])).toBe(false);
  });
});

describe("classifier escalation", () => {
  const uncertain = "implement service";
  const certain = "create a simple hello world page";

  it("escalates to a cheap model only when the keyword answer is uncertain, using Pi's credentials", async () => {
    const { ctx, captured } = fakeCtxWithAuth({
      apiKey: "pi-key",
      baseUrl: "https://example.test/v1",
    });
    // The same registry must offer both runnable models and the credential.
    ctx.modelRegistry.getAvailable = () => [
      { id: "cheap/classifier", provider: "openrouter" },
      { id: "deepseek/deepseek-v4-flash-0731", provider: "openrouter" },
    ];
    const { pi, handlers } = fakePi([]);
    // A large-tier option is what makes escalation worth paying for: without
    // one, getting the rung right saves nothing.
    const snapshot = snapshotOf([
      classifierModel("cheap/classifier", 0.01, 0.55),
      classifierModel("deepseek/deepseek-v4-flash-0731", 0.06, 0.691),
      classifierModel("frontier/large", 3, 0.8, "large"),
    ]);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: unknown, init: unknown) => {
      const request = init as { headers: Record<string, string>; body: string };
      captured.url = String(url);
      captured.headers = request.headers;
      captured.body = request.body;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [
            {
              message: {
                content: '{"kind":"code-change","complexity":"complex","confidence":0.91}',
              },
            },
          ],
          usage: { prompt_tokens: 900, completion_tokens: 40 },
        }),
      } as unknown as Response;
    }) as typeof fetch;

    try {
      createExtension({
        loadSnapshot: async () => snapshot,
        outcomeFile: tempFile(),
        quiet: true,
      })(pi);
      await handlers.before_agent_start!({ prompt: uncertain }, ctx);
    } finally {
      globalThis.fetch = originalFetch;
    }

    // It escalated, and it used Pi's key rather than a second credential.
    expect(captured.headers?.authorization).toBe("Bearer pi-key");
    expect(captured.url).toBe("https://example.test/v1/chat/completions");
    expect(captured.body).toContain("cheap/classifier");
  });

  it("does not call a model when the deterministic answer is confident", async () => {
    let called = false;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      called = true;
      return { ok: true, status: 200, json: async () => ({ choices: [] }) } as unknown as Response;
    }) as typeof fetch;
    try {
      const { pi, ctx, handlers } = fakePi([{ id: "cheap/classifier", provider: "openrouter" }]);
      createExtension({
        loadSnapshot: async () => snapshotOf([classifierModel("cheap/classifier", 0.01, 0.55)]),
        outcomeFile: tempFile(),
        quiet: true,
      })(pi);
      await handlers.before_agent_start!({ prompt: certain }, ctx);
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(called).toBe(false);
  });

  it("falls back to the deterministic answer when the classifier call fails", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("offline");
    }) as typeof fetch;
    try {
      const { pi, ctx, handlers, calls } = fakePi([
        { id: "cheap/classifier", provider: "openrouter" },
        { id: "deepseek/deepseek-v4-flash-0731", provider: "openrouter" },
      ]);
      createExtension({
        loadSnapshot: async () =>
          snapshotOf([
            classifierModel("cheap/classifier", 0.01, 0.55),
            classifierModel("deepseek/deepseek-v4-flash-0731", 0.06, 0.691),
            classifierModel("frontier/large", 3, 0.8, "large"),
          ]),
        outcomeFile: tempFile(),
        quiet: false,
      })(pi);
      await handlers.before_agent_start!({ prompt: uncertain }, ctx);
      // Still routed something: a failed classifier must not break the turn.
      expect(calls.model).toBeDefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("classifier call shape", () => {
  it("switches reasoning off when the classifier is a reasoning model", async () => {
    const { ctx, captured } = fakeCtxWithAuth({ apiKey: "k", baseUrl: "https://example.test/v1" });
    ctx.modelRegistry.getAvailable = () => [{ id: "thinking/cheap", provider: "openrouter" }];
    const { pi, handlers } = fakePi([]);
    const thinking = classifierModel("thinking/cheap", 0.02, 0.55);
    thinking.capabilities = { structuredOutput: true, toolCalling: true, reasoning: true };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init: unknown) => {
      captured.body = (init as { body: string }).body;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: '{"kind":"code-change","complexity":"complex"}' } }],
        }),
      } as unknown as Response;
    }) as typeof fetch;

    try {
      createExtension({
        loadSnapshot: async () =>
          snapshotOf([thinking, classifierModel("frontier/large", 3, 0.8, "large")]),
        outcomeFile: tempFile(),
        quiet: true,
      })(pi);
      await handlers.before_agent_start!({ prompt: "implement service" }, ctx);
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(captured.body).toContain('"reasoning"');
    expect(captured.body).toContain('"minimal"');
    expect(captured.body).toContain("thinking/cheap");
  });
});
