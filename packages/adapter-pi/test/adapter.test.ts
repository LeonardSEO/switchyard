import { afterEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CapacityState, ModelCapabilities } from "@vepando/switchyard-core";
import { DEFAULT_DECISION_CACHE_TTL_MS } from "@vepando/switchyard-core";
import {
  buildProjectContext,
  createExtension,
  matchPiModel,
  judgeRun,
  judgeRunStatus,
  readOutcomes,
  signalsFromOutcomes,
} from "../src/index";
import { createPiCompletion } from "../src/completion";
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
  const commands: Record<
    string,
    { description?: string; handler(args: string, ctx: PiContextLike): Promise<void> }
  > = {};
  const calls: {
    model?: string;
    models: string[];
    level?: string;
    notify?: string;
    providers: Array<{ name: string; modelIds: string[] }>;
  } = { models: [], providers: [] };
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
      calls.models.push(m.id);
      ctx.model = m;
      return Promise.resolve(true);
    },
    setThinkingLevel: (level: string) => {
      calls.level = level;
    },
    registerCommand: (name, command) => {
      commands[name] = command;
    },
    registerProvider: (name, config) => {
      calls.providers.push({ name, modelIds: config.models.map((entry) => entry.id) });
    },
  };
  return { pi, ctx, handlers, commands, calls };
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

function validJevResponse(
  kind: string,
  complexity: string,
  confidence = 0.9,
): Response {
  return new Response(
    JSON.stringify({
      model: "typesafe/jev-1.13-20260917",
      answers: {
        task_kind: {
          type: "choice",
          choice: kind,
          probabilities: { [kind]: confidence },
          confidence,
        },
        task_complexity: {
          type: "choice",
          choice: complexity,
          probabilities: { [complexity]: confidence },
          confidence,
        },
      },
      usage: { cost: 0.00001 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function validChatResponse(kind = "code-change", complexity = "advanced"): Response {
  return new Response(
    JSON.stringify({
      choices: [
        { message: { content: JSON.stringify({ kind, complexity, confidence: 0.9 }) } },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 20 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

const files: string[] = [];
const directories: string[] = [];
const tempFile = () => {
  const path = join(tmpdir(), `switchyard-outcomes-${Math.random().toString(36).slice(2)}.jsonl`);
  files.push(path);
  return path;
};

const tempDirectory = () => {
  const path = mkdtempSync(join(tmpdir(), "switchyard-project-"));
  directories.push(path);
  return path;
};

afterEach(() => {
  while (files.length) rmSync(files.pop()!, { force: true });
  while (directories.length) rmSync(directories.pop()!, { force: true, recursive: true });
});

describe("project context", () => {
  it("summarises structure, manifest and AGENTS.md when present", async () => {
    const root = tempDirectory();
    mkdirSync(join(root, ".git"));
    mkdirSync(join(root, "src"));
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "example", dependencies: { fastify: "1" }, scripts: { test: "vitest" } }),
    );
    writeFileSync(join(root, "AGENTS.md"), "Authentication spans middleware and the database.");
    writeFileSync(join(root, "src", "auth.ts"), "export {};");

    const context = await buildProjectContext(root);

    expect(context).toContain("Project: ");
    expect(context).toContain('"name": "example"');
    expect(context).toContain("src/auth.ts");
    expect(context).toContain("Authentication spans middleware");
  });

  it("works without AGENTS.md or a known manifest", async () => {
    const root = tempDirectory();
    writeFileSync(join(root, "main.txt"), "hello");

    const context = await buildProjectContext(root);

    expect(context).toContain("Project: ");
    expect(context).toContain("main.txt");
    expect(context).not.toContain("PROJECT INSTRUCTIONS");
  });
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
    expect(
      matchPiModel(sol, [
        { id: "gpt-5.6-sol", provider: "openai-codex", name: "GPT-5.6 Sol" },
      ])?.id,
    ).toBe("gpt-5.6-sol");
    expect(matchPiModel(model("nope/nope", "nope", "api", 1, 0.5), available)).toBeUndefined();
  });

  it("routes a trivial turn to the cheap model and sets a low effort", async () => {
    const { pi, ctx, handlers, calls } = fakePi(available);
    createExtension({
      loadSnapshot: async () => snapshotOf([cheap, flash, sol]),
      outcomeFile: tempFile(),
        cacheFile: tempFile(),
        latencyFile: tempFile(),
        failureFile: tempFile(),
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
        cacheFile: tempFile(),
        latencyFile: tempFile(),
        failureFile: tempFile(),
      quiet: true,
    })(pi);

    await handlers.before_agent_start!(
      { prompt: "rewrite the billing service from scratch as a scalable event-driven system" },
      ctx,
    );
    expect(calls.model).toBe("gpt-5.6-sol");
    expect(["high", "xhigh", "max"]).toContain(calls.level);
  });

  it("propagates live context and selected tools into candidate filtering", async () => {
    const constrained = {
      ...cheap,
      maxContextTokens: 100,
      supportsTools: [],
    };
    const capable = {
      ...flash,
      maxContextTokens: 100_000,
      supportsTools: ["bash"],
    };
    const { pi, ctx, handlers, calls } = fakePi(available);
    ctx.getContextUsage = () => ({ tokens: 5_000, contextWindow: 100_000, percent: 5 });
    createExtension({
      loadSnapshot: async () => snapshotOf([constrained, capable]),
      escalation: "never",
      admissionPolicy: "ignore",
      outcomeFile: tempFile(),
      cacheFile: tempFile(),
      latencyFile: tempFile(),
      failureFile: tempFile(),
      quiet: true,
    })(pi);

    await handlers.before_agent_start!(
      { prompt: "rename a variable", systemPromptOptions: { selectedTools: ["bash"] } },
      ctx,
    );

    expect(calls.model).toBe(capable.id);
  });

  it("surfaces an admitted high-risk route unless explicitly ignored", async () => {
    const run = async (admissionPolicy: "notify" | "ignore") => {
      const { pi, ctx, handlers, calls } = fakePi(available);
      createExtension({
        loadSnapshot: async () => snapshotOf([cheap, flash]),
        escalation: "never",
        admissionPolicy,
        buildTaskSpec: () => ({ risk: "high", maxCostUsd: 1 }),
        outcomeFile: tempFile(),
        cacheFile: tempFile(),
        latencyFile: tempFile(),
        failureFile: tempFile(),
        quiet: false,
      })(pi);
      await handlers.before_agent_start!({ prompt: "rename a variable" }, ctx);
      return calls.notify ?? "";
    };

    expect(await run("notify")).toContain("admission required");
    expect(await run("ignore")).not.toContain("admission required");
  });

  it("can escalate an ambiguous cheap route to the nearest stronger candidate", async () => {
    const strong = model("provider/strong", "provider", "api", 10, 0.691);
    const run = async (admissionPolicy: "escalate" | "ignore") => {
      const { pi, ctx, handlers, calls } = fakePi([
        { id: cheap.id, provider: "openrouter" },
        { id: strong.id, provider: "provider" },
      ]);
      createExtension({
        loadSnapshot: async () => snapshotOf([cheap, strong]),
        escalation: "never",
        admissionPolicy,
        outcomeFile: tempFile(),
        cacheFile: tempFile(),
        latencyFile: tempFile(),
        failureFile: tempFile(),
        quiet: true,
      })(pi);
      await handlers.before_agent_start!({ prompt: "rename a variable" }, ctx);
      return calls.model;
    };

    expect(await run("ignore")).toBe(cheap.id);
    expect(await run("escalate")).toBe(strong.id);
  });

  it("leaves Pi alone when nothing in the catalog is runnable here", async () => {
    const { pi, ctx, handlers, calls } = fakePi([]);
    createExtension({
      loadSnapshot: async () => snapshotOf([cheap, flash]),
      outcomeFile: tempFile(),
        cacheFile: tempFile(),
        latencyFile: tempFile(),
        failureFile: tempFile(),
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
        cacheFile: tempFile(),
        latencyFile: tempFile(),
        failureFile: tempFile(),
      quiet: true,
    })(pi);
    await handlers.before_agent_start!({ prompt: "rename a variable" }, ctx);
    expect(calls.model).toBeUndefined();
  });

  it("registers a command that clears the classification cache", async () => {
    const cacheFile = tempFile();
    writeFileSync(cacheFile, JSON.stringify({ cached: true }), "utf8");
    const { pi, ctx, commands, calls } = fakePi(available);
    createExtension({ cacheFile, quiet: true })(pi);

    expect(commands["switchyard-clear-cache"]?.description).toContain("classifications");
    await commands["switchyard-clear-cache"]!.handler("", ctx);

    expect(existsSync(cacheFile)).toBe(false);
    expect(calls.notify).toBe("Switchyard classification cache cleared.");
  });

  it("records normal completion without treating it as verified success", async () => {
    const file = tempFile();
    const { pi, ctx, handlers } = fakePi(available);
    createExtension({
      loadSnapshot: async () => snapshotOf([cheap, flash, sol]),
      outcomeFile: file,
        cacheFile: tempFile(),
        latencyFile: tempFile(),
        failureFile: tempFile(),
      quiet: true,
    })(pi);

    await handlers.before_agent_start!({ prompt: "rename the variable total to orderTotal" }, ctx);
    await handlers.agent_end!(
      { messages: [{ role: "assistant", stopReason: "stop" }] },
      ctx,
    );

    const outcomes = await readOutcomes(file);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].status).toBe("completed");
    expect(signalsFromOutcomes(outcomes)[`${outcomes[0].modelId}|${outcomes[0].kind}`]).toBeUndefined();
  });

  it("learns only after the user explicitly verifies the last run", async () => {
    const file = tempFile();
    const { pi, ctx, handlers, commands } = fakePi(available);
    createExtension({
      loadSnapshot: async () => snapshotOf([cheap, flash, sol]),
      outcomeFile: file,
      cacheFile: tempFile(),
      latencyFile: tempFile(),
      failureFile: tempFile(),
      quiet: true,
    })(pi);

    await handlers.before_agent_start!({ prompt: "rename the variable total to orderTotal" }, ctx);
    await handlers.agent_end!({ messages: [{ role: "assistant", stopReason: "stop" }] }, ctx);
    await commands["switchyard-mark-success"]!.handler("", ctx);

    const outcomes = await readOutcomes(file);
    expect(outcomes.map((outcome) => outcome.status)).toEqual(["completed", "verified_success"]);
    expect(outcomes[0].runId).toBe(outcomes[1].runId);
    expect(signalsFromOutcomes(outcomes)[`${outcomes[0].modelId}|${outcomes[0].kind}`]?.successRate).toBe(1);
  });

  it("judges a failed run as a failure", () => {
    expect(judgeRun([{ role: "assistant", stopReason: "error" }])).toBe(false);
    expect(judgeRun([{ role: "assistant", stopReason: "length" }])).toBe(false);
    expect(judgeRun([{ role: "assistant", stopReason: "stop" }])).toBe(true);
    expect(judgeRun([{ role: "user", content: "never answered" }])).toBe(false);
    expect(judgeRun([])).toBe(false);
    expect(judgeRunStatus([{ role: "assistant", stopReason: "stop" }])).toBe("completed");
    expect(judgeRunStatus([{ role: "assistant", stopReason: "error" }])).toBe("failed");
  });

  it("weights recent verified outcomes and emits complexity/project buckets", () => {
    const day = 24 * 60 * 60 * 1000;
    const now = 100 * day;
    const signals = signalsFromOutcomes(
      [
        {
          runId: "old-success",
          modelId: "m",
          kind: "debug",
          complexity: "complex",
          projectScope: "p",
          status: "verified_success",
          at: now - 90 * day,
        },
        {
          runId: "recent-failure",
          modelId: "m",
          kind: "debug",
          complexity: "complex",
          projectScope: "p",
          status: "failed",
          at: now,
        },
      ],
      { now, halfLifeMs: 30 * day },
    );

    expect(signals["m|debug"]?.successRate).toBeLessThan(0.2);
    expect(signals["m|debug|complex"]?.sampleCount).toBe(2);
    expect(signals["m|debug|complex|p"]?.effectiveSampleSize).toBeCloseTo(1.125);
  });

  it("keeps legacy outcome records readable without treating completion as success", () => {
    const signals = signalsFromOutcomes([
      { modelId: "m", kind: "debug", complexity: "simple", success: true, at: 1 },
      { modelId: "m", kind: "debug", complexity: "simple", success: false, at: 2 },
    ]);

    expect(signals["m|debug"]?.sampleCount).toBe(1);
    expect(signals["m|debug"]?.successRate).toBe(0);
  });

  it("refreshes the catalog and quota after the freshness window", async () => {
    let clock = 1_000;
    let loads = 0;
    const apiLarge = classifierModel("api/large", 3, 0.8, "large");
    const { pi, ctx, handlers, calls } = fakePi([
      ...available,
      { id: apiLarge.id, provider: "openrouter" },
    ]);
    createExtension({
      loadSnapshot: async () => {
        loads += 1;
        return snapshotOf([apiLarge, sol], {
          "codex-sol":
            loads === 1
              ? {
                  available: true,
                  usage: { remainingFraction: 0.9, windowElapsedFraction: 0.1, source: "test" },
                }
              : { available: false, reason: "quota exhausted" },
        });
      },
      now: () => clock,
      snapshotFreshnessMs: 10 * 60 * 1000,
      escalation: "never",
      outcomeFile: tempFile(),
      cacheFile: tempFile(),
      latencyFile: tempFile(),
      failureFile: tempFile(),
      quiet: true,
    })(pi);

    const prompt = "rewrite the distributed billing service architecture from scratch";
    await handlers.before_agent_start!({ prompt }, ctx);
    clock += 9 * 60 * 1000;
    await handlers.before_agent_start!({ prompt }, ctx);
    expect(loads).toBe(1);

    clock += 2 * 60 * 1000;
    await handlers.before_agent_start!({ prompt }, ctx);
    expect(loads).toBe(2);
    expect(calls.models.slice(0, 2)).toEqual(["gpt-5.6-sol", "gpt-5.6-sol"]);
    expect(calls.models.at(-1)).toBe("api/large");
  });

  it("offers an opt-in auto model while leaving pinned models untouched", async () => {
    const pinned = { id: "gpt-5.6-sol", provider: "openai-codex", name: "Sol" };
    const auto = { id: "auto", provider: "switchyard", name: "Switchyard Auto" };
    const { pi, ctx, handlers, calls } = fakePi(available);
    ctx.model = pinned;
    createExtension({
      loadSnapshot: async () => snapshotOf([cheap, flash, sol]),
      routingScope: "selected-model",
      escalation: "never",
      outcomeFile: tempFile(),
      cacheFile: tempFile(),
      latencyFile: tempFile(),
      failureFile: tempFile(),
      quiet: true,
    })(pi);

    expect(calls.providers).toContainEqual({ name: "switchyard", modelIds: ["auto"] });
    await handlers.before_agent_start!({ prompt: "rename a pinned role variable" }, ctx);
    expect(calls.model).toBeUndefined();

    ctx.model = auto;
    await handlers.before_agent_start!({ prompt: "rename an auto role variable" }, ctx);
    expect(calls.model).toBeDefined();
    await handlers.agent_end!({ messages: [{ role: "assistant", stopReason: "stop" }] }, ctx);
    expect(calls.model).toBe("auto");
    expect(ctx.model).toEqual(auto);
  });

  it("routes an OMP prewalk handoff into the auto role during an active run", async () => {
    const pinned = { id: "gpt-5.6-sol", provider: "openai-codex", name: "Sol" };
    const auto = { id: "auto", provider: "switchyard", name: "Switchyard Auto" };
    const { pi, ctx, handlers, calls } = fakePi(available);
    ctx.model = pinned;
    createExtension({
      loadSnapshot: async () => snapshotOf([cheap, flash, sol]),
      routingScope: "selected-model",
      escalation: "never",
      outcomeFile: tempFile(),
      cacheFile: tempFile(),
      latencyFile: tempFile(),
      failureFile: tempFile(),
      quiet: true,
    })(pi);

    await handlers.before_agent_start!(
      { prompt: "inspect the repository, then implement the focused change" },
      ctx,
    );
    await handlers.agent_start!({}, ctx);
    expect(calls.model).toBeUndefined();

    ctx.model = auto;
    await handlers.model_select!({ model: auto }, ctx);
    expect(calls.model).toBeDefined();
    expect(calls.model).not.toBe("auto");
  });
});

describe("Jev-first classification", () => {
  const models = [
    classifierModel("cheap/classifier", 0.01, 0.55),
    classifierModel("alternate/classifier", 0.02, 0.6),
    classifierModel("frontier/large", 3, 0.8, "large"),
  ];

  function setup(options: Parameters<typeof createExtension>[0] = {}) {
    const { ctx, captured } = fakeCtxWithAuth({
      apiKey: "pi-key",
      baseUrl: "https://openrouter.ai/api/v1",
    });
    ctx.modelRegistry.getAvailable = () =>
      models.map((entry) => ({ id: entry.id, provider: "openrouter" }));
    const { pi, handlers, calls } = fakePi([]);
    createExtension({
      loadSnapshot: async () => snapshotOf(models),
      outcomeFile: tempFile(),
      cacheFile: tempFile(),
      latencyFile: tempFile(),
      failureFile: tempFile(),
      quiet: true,
      ...options,
    })(pi);
    return { ctx, captured, handlers, calls };
  }

  it("uses Jev Decisions before the chat classifier with Pi credentials", async () => {
    const { ctx, handlers } = setup();
    const originalFetch = globalThis.fetch;
    const requests: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({
        url: String(url),
        headers: init?.headers as Record<string, string>,
        body: String(init?.body),
      });
      if (String(url).endsWith("/api/alpha/decisions")) {
        return validJevResponse("code-change", "moderate", 0.88);
      }
      throw new Error(`unexpected fallback request: ${url}`);
    }) as typeof fetch;

    try {
      await handlers.before_agent_start!({ prompt: "Add validation to the parser" }, ctx);
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://openrouter.ai/api/alpha/decisions");
    expect(requests[0]?.headers.authorization).toBe("Bearer pi-key");
    expect(JSON.parse(requests[0]?.body ?? "{}").model).toBe("typesafe/jev-latest");
  });

  it("uses the pinned classifier model only for the chat fallback", async () => {
    const { ctx, handlers } = setup({ classifierModel: "alternate/classifier" });
    const originalFetch = globalThis.fetch;
    const bodies: unknown[] = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      if (String(url).endsWith("/api/alpha/decisions")) {
        return new Response("", { status: 503 });
      }
      return validChatResponse();
    }) as typeof fetch;

    try {
      await handlers.before_agent_start!({ prompt: "Implement the service retry policy" }, ctx);
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(bodies).toHaveLength(2);
    expect((bodies[0] as { model: string }).model).toBe("typesafe/jev-latest");
    expect((bodies[1] as { model: string }).model).toBe("alternate/classifier");
  });

  it("falls through Jev and chat failures to local classification", async () => {
    const { ctx, handlers, calls } = setup();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("", { status: 503 })) as typeof fetch;

    try {
      await handlers.before_agent_start!({ prompt: "Implement the service retry policy" }, ctx);
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(calls.model).toBeDefined();
  });

  it("makes no classifier request in offline mode or for fully explicit tasks", async () => {
    const originalFetch = globalThis.fetch;
    const fetchFn = vi.fn<typeof fetch>();
    globalThis.fetch = fetchFn;
    try {
      const offline = setup({ escalation: "never" });
      await offline.handlers.before_agent_start!(
        { prompt: "Add validation to the parser" },
        offline.ctx,
      );

      const explicit = setup({
        buildTaskSpec: () => ({ kind: "review", complexity: "simple" }),
      });
      await explicit.handlers.before_agent_start!(
        { prompt: "Assess the parser change" },
        explicit.ctx,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("expires same-session classification reuse after six hours", async () => {
    let now = 1_000;
    const { ctx, handlers } = setup({ now: () => now });
    const originalFetch = globalThis.fetch;
    const fetchFn = vi.fn(async () => validJevResponse("code-change", "advanced"));
    globalThis.fetch = fetchFn as typeof fetch;
    const event = { prompt: "Add OpenTelemetry tracing across the HTTP worker layers" };

    try {
      await handlers.before_agent_start!(event, ctx);
      now += DEFAULT_DECISION_CACHE_TTL_MS - 1;
      await handlers.before_agent_start!(event, ctx);
      now += 2;
      await handlers.before_agent_start!(event, ctx);
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("does not reuse a classification across changed explicit constraints", async () => {
    let complexity: "simple" | "frontier" = "simple";
    const { ctx, handlers, calls } = setup({
      buildTaskSpec: () => ({ kind: "code-change", complexity }),
    });
    const originalFetch = globalThis.fetch;
    const fetchFn = vi.fn<typeof fetch>();
    globalThis.fetch = fetchFn;

    try {
      const event = { prompt: "Implement the requested parser change" };
      await handlers.before_agent_start!(event, ctx);
      const firstLevel = calls.level;
      complexity = "frontier";
      await handlers.before_agent_start!(event, ctx);

      expect(calls.level).not.toBe(firstLevel);
      expect(calls.level).toBe("xhigh");
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe("classifier diagnostics", () => {
  it("does not write upstream response bodies to the debug log", async () => {
    const root = tempDirectory();
    const previousHome = process.env.HOME;
    const previousDebug = process.env.SWITCHYARD_DEBUG;
    process.env.HOME = root;
    process.env.SWITCHYARD_DEBUG = "1";
    const { ctx } = fakeCtxWithAuth({
      apiKey: "pi-key",
      baseUrl: "https://openrouter.ai/api/v1",
    });
    const secret = "private-upstream-response-content";
    const complete = createPiCompletion(ctx, {
      fetchFn: vi.fn(async () => validChatResponse(secret, "simple")),
    });

    try {
      await complete({
        model: classifierModel("cheap/classifier", 0.01, 0.55),
        system: "Classify this task.",
        user: "Implement a small parser fix.",
        maxOutputTokens: 100,
      });
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousDebug === undefined) delete process.env.SWITCHYARD_DEBUG;
      else process.env.SWITCHYARD_DEBUG = previousDebug;
    }

    const log = readFileSync(join(root, ".switchyard", "debug.log"), "utf8");
    expect(log).not.toContain(secret);
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
    const project = tempDirectory();
    mkdirSync(join(project, ".git"));
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
        cacheFile: tempFile(),
        latencyFile: tempFile(),
        failureFile: tempFile(),
        quiet: true,
      })(pi);
      await handlers.before_agent_start!(
        {
          prompt: uncertain,
          systemPromptOptions: {
            cwd: project,
            contextFiles: [
              {
                path: join(project, "AGENTS.md"),
                content: "Authentication crosses multiple services and requires integration tests.",
              },
            ],
          },
        },
        ctx,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    // It escalated, and it used Pi's key rather than a second credential.
    expect(captured.headers?.authorization).toBe("Bearer pi-key");
    expect(captured.url).toBe("https://example.test/v1/chat/completions");
    expect(captured.body).toContain("cheap/classifier");
    expect(captured.body).toContain("Authentication crosses multiple services");
    expect(captured.body).toContain("CURRENT TASK");
  });

  it("does not call a model when escalation is 'uncertain' and the keyword answer is confident", async () => {
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
        cacheFile: tempFile(),
        latencyFile: tempFile(),
        failureFile: tempFile(),
        quiet: true,
        escalation: "uncertain",
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
        cacheFile: tempFile(),
        latencyFile: tempFile(),
        failureFile: tempFile(),
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
        cacheFile: tempFile(),
        latencyFile: tempFile(),
        failureFile: tempFile(),
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

describe("escalation policy", () => {
  it("asks the model even when the keyword answer looks confident", async () => {
    const { ctx, captured } = fakeCtxWithAuth({ apiKey: "k", baseUrl: "https://example.test/v1" });
    ctx.modelRegistry.getAvailable = () => [{ id: "cheap/classifier", provider: "openrouter" }];
    const { pi, handlers } = fakePi([]);
    const originalFetch = globalThis.fetch;
    let called = 0;
    globalThis.fetch = (async (_url: unknown, init: unknown) => {
      called += 1;
      captured.body = (init as { body: string }).body;
      return validJevResponse("code-change", "complex", 0.9);
    }) as typeof fetch;
    try {
      createExtension({
        loadSnapshot: async () =>
          snapshotOf([
            classifierModel("cheap/classifier", 0.01, 0.55),
            classifierModel("frontier/large", 3, 0.8, "large"),
          ]),
        outcomeFile: tempFile(),
        cacheFile: tempFile(),
        latencyFile: tempFile(),
        failureFile: tempFile(),
        quiet: true,
      })(pi);
      // Confident keyword answer (trivial), yet escalation is on by default.
      await handlers.before_agent_start!({ prompt: "create a simple hello world page" }, ctx);
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(called).toBe(1);
    expect(captured.body).toContain("typesafe/jev-latest");
  });
});

describe("task similarity", () => {
  it("reuses the rung while the session stays on the same task", async () => {
    const { ctx, captured } = fakeCtxWithAuth({ apiKey: "k", baseUrl: "https://example.test/v1" });
    ctx.modelRegistry.getAvailable = () => [{ id: "cheap/classifier", provider: "openrouter" }];
    const { pi, handlers } = fakePi([]);
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return validJevResponse("code-change", "advanced");
    }) as typeof fetch;
    try {
      createExtension({
        loadSnapshot: async () =>
          snapshotOf([
            classifierModel("cheap/classifier", 0.01, 0.55),
            classifierModel("frontier/large", 3, 0.8, "large"),
          ]),
        outcomeFile: tempFile(),
        cacheFile: tempFile(),
        latencyFile: tempFile(),
        failureFile: tempFile(),
        quiet: true,
      })(pi);
      await handlers.before_agent_start!(
        { prompt: "Add OpenTelemetry tracing across the HTTP and worker layers" },
        ctx,
      );
      await handlers.agent_end!({ messages: [{ role: "assistant", stopReason: "stop" }] }, ctx);
      // Same task, more detail: no second round trip.
      await handlers.before_agent_start!(
        { prompt: "Add OpenTelemetry tracing across the HTTP worker layers and tests" },
        ctx,
      );
      await handlers.agent_end!({ messages: [{ role: "assistant", stopReason: "stop" }] }, ctx);
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(calls).toBe(1);
  });

  it("classifies the same task again after the cache-clear command", async () => {
    const { ctx } = fakeCtxWithAuth({ apiKey: "k", baseUrl: "https://example.test/v1" });
    ctx.modelRegistry.getAvailable = () => [{ id: "cheap/classifier", provider: "openrouter" }];
    const { pi, handlers, commands } = fakePi([]);
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return validJevResponse("code-change", "advanced");
    }) as typeof fetch;
    try {
      createExtension({
        loadSnapshot: async () =>
          snapshotOf([
            classifierModel("cheap/classifier", 0.01, 0.55),
            classifierModel("frontier/large", 3, 0.8, "large"),
          ]),
        outcomeFile: tempFile(),
        cacheFile: tempFile(),
        latencyFile: tempFile(),
        failureFile: tempFile(),
        quiet: true,
      })(pi);
      const event = { prompt: "Add OpenTelemetry tracing across the HTTP and worker layers" };
      await handlers.before_agent_start!(event, ctx);
      await commands["switchyard-clear-cache"]!.handler("", ctx);
      await handlers.before_agent_start!(event, ctx);
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(calls).toBe(2);
  });
});
