/**
 * Offline measuring stick. No network, no providers, no credentials.
 *
 *   npm run bench              # print tables, exit 0
 *   npm run bench -- --strict  # exit 1 on any failed expectation
 *
 * The three sections answer different questions, deliberately kept apart:
 *
 *   1. classifier accuracy — does keyword inference agree with ground truth?
 *   2. oracle-cold routing — given the right complexity, does the router pick a
 *      sensible model with no history? (cold start, the hard case)
 *   3. oracle-warm routing — same, with per-kind success rates observed from
 *      the corpus outcomes. This is leaky on purpose: it models "after this
 *      workload has been seen" and shows what the feedback loop is worth.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  keywordClassification,
  route,
  type CapacityState,
  type Complexity,
  type ModelCapabilities,
  type RoutingSignal,
  type TaskKind,
  type TaskSpec,
} from "../packages/core/src/index";

interface Scenario {
  id: string;
  source: string;
  note?: string;
  assertWarm?: boolean;
  task: TaskSpec;
  capacity?: Record<string, CapacityState>;
  outcomes?: Record<string, { success: boolean }>;
  expect: { complexity?: Complexity; modelIdIn: string[] };
}

const here = dirname(fileURLToPath(import.meta.url));
const corpus = JSON.parse(
  readFileSync(join(here, "corpus.json"), "utf8"),
) as { models: ModelCapabilities[]; scenarios: Scenario[] };

const strict = process.argv.includes("--strict");
let failures = 0;

/** Per-kind and global success rates, observed from the corpus outcomes. */
function buildSignals(): Record<string, RoutingSignal> {
  const perKind = new Map<string, { ok: number; total: number }>();
  const global = new Map<string, { ok: number; total: number }>();
  for (const s of corpus.scenarios) {
    const kind = s.task.kind;
    for (const [modelId, outcome] of Object.entries(s.outcomes ?? {})) {
      const g = global.get(modelId) ?? { ok: 0, total: 0 };
      g.total += 1;
      if (outcome.success) g.ok += 1;
      global.set(modelId, g);
      if (kind) {
        const k = perKind.get(`${modelId}|${kind}`) ?? { ok: 0, total: 0 };
        k.total += 1;
        if (outcome.success) k.ok += 1;
        perKind.set(`${modelId}|${kind}`, k);
      }
    }
  }
  const signals: Record<string, RoutingSignal> = {};
  for (const [id, t] of global) signals[id] = { successRate: t.ok / t.total, rejectRate: 0 };
  for (const [id, t] of perKind) signals[id] = { successRate: t.ok / t.total, rejectRate: 0 };
  return signals;
}

const signals = buildSignals();

/** Ground-truth complexity: removes classifier quality from the routing test. */
function oracleTask(s: Scenario): TaskSpec {
  return { ...s.task, complexity: s.expect.complexity };
}

function runRouting(
  label: string,
  mode: "cold" | "warm",
  task: (s: Scenario) => TaskSpec,
): void {
  console.log(`\n=== ${label} ===`);
  console.log(["scenario", "chosen", "$est", "effort", "adm", "pruned", "result"].join("\t"));
  let pass = 0;
  let asserted = 0;
  for (const s of corpus.scenarios) {
    if (mode === "warm" && s.assertWarm === false) continue;
    asserted += 1;
    const t = task(s);
    const cls = keywordClassification(t);
    const d = route(t, corpus.models, cls, {
      capacity: s.capacity,
      signals: mode === "warm" ? signals : undefined,
    });
    const ok = !!d.model && s.expect.modelIdIn.includes(d.model.id);
    if (ok) pass += 1;
    else failures += 1;
    const cost = d.ranked[0]?.estCostUsd;
    console.log(
      [
        s.id,
        d.model?.id ?? "none",
        cost?.known ? cost.value.toFixed(6) : "?",
        d.effort,
        d.admissionRequired ? "y" : "n",
        String(d.pruned.length),
        ok ? "PASS" : `FAIL (want ${s.expect.modelIdIn.join("|")})`,
      ].join("\t"),
    );
  }
  console.log(`${label}: ${pass}/${asserted} pass`);
}

// 1. Classifier accuracy.
console.log("=== classifier accuracy (keyword inference vs ground truth) ===");
let complexityHits = 0;
for (const s of corpus.scenarios) {
  if (!s.expect.complexity) continue;
  const got = keywordClassification(s.task).complexity;
  const hit = got === s.expect.complexity;
  if (hit) complexityHits += 1;
  console.log(`${s.id}\tinferred=${got}\ttruth=${s.expect.complexity}\t${hit ? "ok" : "MISS"}`);
}
console.log(`complexity: ${complexityHits}/${corpus.scenarios.length} correct`);

// 2 and 3. Routing.
runRouting("oracle-cold (right complexity, no history)", "cold", oracleTask);
runRouting("oracle-warm (right complexity, per-kind history)", "warm", oracleTask);

// Quota sensitivity: one task, three capacity states.
console.log("\n=== quota sensitivity: Implement pagination for the orders API endpoint ===");
const task: TaskSpec = {
  kind: "code-change" as TaskKind,
  risk: "medium",
  objective: "Implement pagination for the orders API endpoint.",
};
for (const [label, remaining, elapsed] of [
  ["quota will expire unused", 0.95, 0.05],
  ["on pace", 0.6, 0.4],
  ["nearly drained", 0.05, 0.9],
] as const) {
  const capacity: Record<string, CapacityState> = {};
  for (const id of ["codex-luna", "codex-terra", "codex-sol", "codex-astra"]) {
    capacity[id] = {
      available: true,
      usage: { remainingFraction: remaining, windowElapsedFraction: elapsed, source: "bench" },
    };
  }
  const d = route(task, corpus.models, keywordClassification(task), { capacity });
  console.log(`${label.padEnd(26)} r=${remaining} w=${elapsed}  -> ${d.model?.id ?? "none"}`);
}

if (strict && failures > 0) {
  console.error(`\n${failures} expectation(s) failed`);
  process.exit(1);
}
