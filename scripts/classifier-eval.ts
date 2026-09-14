/**
 * Does the model classifier actually beat keywords, and is it worth the call?
 *
 *   npm run eval:classifier            # replay cached answers
 *   npm run eval:classifier -- --live  # make real calls (needs a key)
 *
 * Answers are cached per (objective, floors) so the run is reproducible and the
 * comparison does not silently drift as the catalog changes.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  KeywordClassifier,
  ModelClassifier,
  defaultClassifierFloors,
  pickCheapestClassifier,
  type Complexity,
  type TaskSpec,
} from "@switchyard/core";
import { OpenRouterSource, createOpenRouterCompletion } from "@switchyard/provider-openrouter";

interface Scenario {
  id: string;
  task: TaskSpec;
  expect: { complexity?: Complexity };
}

const here = dirname(fileURLToPath(import.meta.url));
const heldout = process.argv.includes("--heldout");
const corpusFile = heldout ? "corpus-heldout.json" : "corpus.json";
const corpus = JSON.parse(
  readFileSync(join(here, "..", "eval", corpusFile), "utf8"),
) as { scenarios: Scenario[] };
const cachePath = join(here, "..", "eval", "classifier-cache.json");
const cache: Record<string, string> = existsSync(cachePath)
  ? JSON.parse(readFileSync(cachePath, "utf8"))
  : {};

const live = process.argv.includes("--live");
/** Ignore the savings gate: measure the classifier, not the gate. */
const forceAll = process.argv.includes("--always");

/** Pi stores an OAuth-minted OpenRouter key; fall back to the environment. */
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

const snapshot = await new OpenRouterSource().list();
const apiModels = snapshot.models;
const classifierModel = pickCheapestClassifier(apiModels, {
  ...defaultClassifierFloors,
  minCapabilityScore: 0.5,
  allowReasoning: true,
});

console.log(`corpus: ${corpusFile}${heldout ? " (held out)" : " (fitting set)"}`);
console.log(`classifier model: ${classifierModel?.id ?? "none"}  mode: ${forceAll ? "always (gate off)" : "gated"}`);
if (!classifierModel) {
  console.error("no classifier model available; cannot evaluate");
  process.exit(1);
}

const key = apiKeyFromPi();
if (live && !key) {
  console.error("no OpenRouter key found (set OPENROUTER_API_KEY or log in via pi)");
  process.exit(1);
}

let calls = 0;
let spend = 0;
const complete = createOpenRouterCompletion({ apiKey: key });

const classifier = new ModelClassifier({
  models: apiModels,
  modelId: classifierModel.id,
  escalation: "always",
  minSavingsFactor: forceAll ? 0 : 25,
  complete: async (req) => {
    const cacheKey = `${req.model.id}|${req.user}`;
    if (!live) {
      const cached = cache[cacheKey];
      if (cached !== undefined) return { text: cached };
      return { text: "" };
    }
    calls += 1;
    const res = await complete(req);
    spend += res.costUsd ?? 0;
    cache[cacheKey] = res.text;
    return res;
  },
});

const keyword = new KeywordClassifier();

console.log(["scenario", "truth", "keyword", "model", "agree?"].join("\t"));
let keywordHits = 0;
let modelHits = 0;
let total = 0;

for (const scenario of corpus.scenarios) {
  const truth = scenario.expect.complexity;
  const task: TaskSpec = { ...scenario.task };
  const kw = await keyword.classify(task);
  const md = await classifier.classify(task);
  const kwHit = kw.complexity === truth;
  const mdHit = md.complexity === truth;
  if (kwHit) keywordHits += 1;
  if (mdHit) modelHits += 1;
  total += 1;
  console.log(
    [scenario.id, truth ?? "?", kw.complexity, md.complexity, kw.complexity === md.complexity ? "same" : "differs"].join("\t"),
  );
}

console.log(`\nkeyword accuracy: ${keywordHits}/${total}`);
console.log(`model accuracy:   ${modelHits}/${total}`);
console.log(`calls made: ${calls}  spend: $${spend.toFixed(6)}`);

if (live && calls > 0) {
  writeFileSync(cachePath, JSON.stringify(cache, null, 2));
  console.log(`cached ${calls} answers to eval/classifier-cache.json`);
}
if (!live) {
  console.log("(replay mode: pass --live to make real calls)");
}
