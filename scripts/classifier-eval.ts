/**
 * Compare task-classification backends on an English corpus.
 *
 *   npm run eval:classifier -- --backend keyword --heldout
 *   npm run eval:classifier -- --backend chat --heldout --live
 *   npm run eval:classifier -- --backend jev --heldout --live
 *
 * Without --live, remote backends replay cached responses and never use the
 * network. Live runs are billable and require an OpenRouter credential.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DecisionClassifier,
  KeywordClassifier,
  ModelClassifier,
  defaultClassifierFloors,
  keywordClassification,
  pickCheapestClassifier,
  type Classifier,
  type Complexity,
  type DecisionFn,
  type DecisionResponse,
  type ModelCapabilities,
  type TaskKind,
  type TaskSpec,
} from "@vepando/switchyard-core";
import {
  createOpenRouterCompletion,
  createOpenRouterDecision,
  OPENROUTER_JEV_LATEST,
  OpenRouterSource,
} from "@vepando/switchyard-provider-openrouter";
import {
  classifierEvalCacheKey,
  classifierEvalCachedModelId,
  parseClassifierEvalArgs,
  summarizeClassifierResults,
  type ClassifierEvalBackend,
  type ClassifierEvalResult,
} from "./classifier-eval-lib.js";

interface Scenario {
  id: string;
  task: TaskSpec;
  expect: {
    kind?: TaskKind;
    complexity?: Complexity;
    rationale?: string;
  };
}

const options = parseClassifierEvalArgs(process.argv.slice(2));
const here = dirname(fileURLToPath(import.meta.url));
const corpusFile = options.heldout ? "corpus-heldout.json" : "corpus.json";
const corpus = JSON.parse(
  readFileSync(join(here, "..", "eval", corpusFile), "utf8"),
) as { scenarios: Scenario[] };
const cachePath = join(here, "..", "eval", "classifier-cache.json");
const cache: Record<string, string> = existsSync(cachePath)
  ? JSON.parse(readFileSync(cachePath, "utf8"))
  : {};

const apiKey = apiKeyFromPi();
if (options.live && options.backend !== "keyword" && !apiKey) {
  console.error("no OpenRouter key found (set OPENROUTER_API_KEY or log in via Pi)");
  process.exit(1);
}

let remoteCalls = 0;
const cacheMisses = new Set<string>();
let selectedChatModel = "none";

const keyword = new KeywordClassifier();
const classifier = await buildClassifier(options.backend);

console.log(`corpus: ${corpusFile}${options.heldout ? " (held out)" : " (fitting set)"}`);
console.log(
  `backend: ${options.backend}  mode: ${options.live ? "live" : "cached replay"}`,
);
if (options.backend === "chat" || options.backend === "jev") {
  console.log(`chat fallback model: ${selectedChatModel}`);
}
console.log(["scenario", "truth", "actual", "source", "fallback", "latency_ms"].join("\t"));

const results: ClassifierEvalResult[] = [];
for (const scenario of corpus.scenarios) {
  const expectedComplexity = scenario.expect.complexity;
  if (!expectedComplexity) continue;
  const expectedKind =
    scenario.expect.kind ??
    scenario.task.kind ??
    keywordClassification(scenario.task).kind;
  const started = performance.now();
  const classification = await classifier.classify({ ...scenario.task });
  const latencyMs = performance.now() - started;
  const fallback =
    classification.fallbackFrom === "jev" || classification.degraded === true;

  results.push({
    expectedKind,
    expectedComplexity,
    actualKind: classification.kind,
    actualComplexity: classification.complexity,
    fallback,
    latencyMs,
    ...(classification.costUsd === undefined ? {} : { costUsd: classification.costUsd }),
  });
  console.log(
    [
      scenario.id,
      `${expectedKind}/${expectedComplexity}`,
      `${classification.kind}/${classification.complexity}`,
      classification.source,
      fallback ? classification.fallbackReason ?? "yes" : "no",
      latencyMs.toFixed(1),
    ].join("\t"),
  );
}

const summary = summarizeClassifierResults(results);
console.log(`\nsamples: ${summary.samples}`);
console.log(`kind accuracy: ${(summary.kindAccuracy * 100).toFixed(1)}%`);
console.log(`complexity accuracy: ${(summary.complexityAccuracy * 100).toFixed(1)}%`);
console.log(`both fields accurate: ${(summary.bothAccuracy * 100).toFixed(1)}%`);
console.log(`underclassifications: ${summary.underclassifications}`);
console.log(
  `fallbacks: ${summary.fallbacks}/${summary.samples} (${(
    summary.fallbackRate * 100
  ).toFixed(1)}%)`,
);
console.log(
  `latency: mean ${summary.meanLatencyMs.toFixed(1)}ms, p95 ${summary.p95LatencyMs.toFixed(1)}ms`,
);
if (summary.totalCostUsd !== undefined) {
  console.log(
    `cost: total $${summary.totalCostUsd.toFixed(6)}, mean $${(
      summary.meanCostUsd ?? 0
    ).toFixed(6)}`,
  );
}
console.log(`remote calls: ${remoteCalls}`);
if (!options.live) {
  console.log(`cache misses: ${cacheMisses.size}`);
  console.log("(cached replay: pass --live to make real calls)");
}
if (options.live && remoteCalls > 0) {
  writeFileSync(cachePath, `${JSON.stringify(cache, null, 2)}\n`);
  console.log(`cached ${remoteCalls} responses in eval/classifier-cache.json`);
}

async function buildClassifier(backend: ClassifierEvalBackend): Promise<Classifier> {
  if (backend === "keyword") return keyword;
  const chat = await buildChatClassifier(backend === "jev");
  if (backend === "chat") return chat;

  const liveDecision = createOpenRouterDecision({ apiKey });
  const decide: DecisionFn = async (request) => {
    const input = JSON.stringify(request);
    const cacheKey = classifierEvalCacheKey("jev", request.model, input);
    if (!options.live) {
      const cached = cache[cacheKey];
      if (cached === undefined) {
        cacheMisses.add(cacheKey);
        throw new Error("Jev evaluation response is not cached");
      }
      return JSON.parse(cached) as DecisionResponse;
    }
    remoteCalls += 1;
    const response = await liveDecision(request);
    cache[cacheKey] = JSON.stringify(response);
    return response;
  };

  return new DecisionClassifier({
    model: OPENROUTER_JEV_LATEST,
    decide,
    fallback: chat,
    escalation: "always",
    ...(options.live ? {} : { failureCooldownMs: 0 }),
  });
}

async function buildChatClassifier(asFallback: boolean): Promise<Classifier> {
  let chatModel: ModelCapabilities;
  if (options.live) {
    const snapshot = await new OpenRouterSource().list();
    const selected = pickCheapestClassifier(snapshot.models, {
      ...defaultClassifierFloors,
      minCapabilityScore: 0.5,
      allowReasoning: true,
    });
    if (!selected) throw new Error("no classifier model available for live evaluation");
    chatModel = selected;
  } else {
    chatModel = cachedChatModel(cache);
  }
  selectedChatModel = chatModel.id;

  const liveCompletion = createOpenRouterCompletion({ apiKey });
  return new ModelClassifier({
    models: [chatModel],
    modelId: chatModel.id,
    escalation: "always",
    minSavingsFactor: asFallback || options.forceAll ? 0 : 25,
    complete: async (request) => {
      const cacheKey = classifierEvalCacheKey("chat", request.model.id, request.user);
      if (!options.live) {
        const cached = cache[cacheKey] ?? cache[`${request.model.id}|${request.user}`];
        if (cached === undefined) {
          cacheMisses.add(cacheKey);
          return { text: "" };
        }
        return { text: cached };
      }
      remoteCalls += 1;
      const response = await liveCompletion(request);
      cache[cacheKey] = response.text;
      return response;
    },
  });
}

function cachedChatModel(entries: Record<string, string>): ModelCapabilities {
  const id = classifierEvalCachedModelId(entries, "chat") ?? "cached/chat-classifier";
  return {
    id,
    provider: "openrouter",
    tier: "mid",
    capabilityScore: 0.6,
    maxContextTokens: 200_000,
    capabilities: { structuredOutput: true, toolCalling: true },
    pricing: {
      kind: "api",
      inputPer1M: { known: true, value: 0.01 },
      outputPer1M: { known: true, value: 0.04 },
    },
  };
}

/** Pi stores an OAuth-minted OpenRouter key; the environment remains explicit precedence. */
function apiKeyFromPi(): string | undefined {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  try {
    const auth = JSON.parse(
      readFileSync(`${process.env.HOME ?? "."}/.pi/agent/auth.json`, "utf8"),
    ) as Record<string, { access?: string } | undefined>;
    return auth.openrouter?.access || undefined;
  } catch {
    return undefined;
  }
}
