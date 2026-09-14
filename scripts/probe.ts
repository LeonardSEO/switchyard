/**
 * Diagnostic probe: what does the router actually do, right now, with the live
 * catalog? Answers, in order:
 *
 *   1. which model classifies, and is that a sane choice?
 *   2. what is routed where?
 *   3. rename vs full rewrite?
 *   4. are unmeasured models (no benchmark) skipped, and does that hold up?
 *   5. what happens to :free and :batch models?
 */
import {
  pickCheapestClassifier,
  defaultClassifierFloors,
  keywordClassification,
  route,
  effectiveInputPer1M,
  type CapacityState,
  type Complexity,
  type ModelCapabilities,
  type TaskSpec,
} from "@vepando/switchyard-core";
import { OpenRouterSource } from "@vepando/switchyard-provider-openrouter";
import { signalsFromCatalog } from "@vepando/switchyard-catalog";
import { buildSnapshot } from "./build-catalog";

const snapshot = await buildSnapshot();
const models = snapshot.models;
const signals = signalsFromCatalog(models);
console.log(`codex quota: ${snapshot.usage.note}  [${snapshot.usage.source}]`);

const price = (
  m: ModelCapabilities,
  capacity: Record<string, CapacityState> = snapshot.capacity,
): number | undefined => {
  const p = effectiveInputPer1M(m, capacity[m.id]);
  return p.known ? p.value : undefined;
};
const kind = (m: ModelCapabilities): string =>
  [
    m.freeTier ? "free" : null,
    m.id.endsWith(":batch") ? "batch" : null,
    m.capabilityScore === undefined ? "unmeasured" : null,
  ]
    .filter(Boolean)
    .join(",") || "measured";

// ---------------------------------------------------------------- 1
console.log("=== 1. classifier model selection ===");
const classifier = pickCheapestClassifier(models, defaultClassifierFloors);
console.log(
  `picked: ${classifier?.id ?? "none"}` +
    (classifier
      ? `  $${price(classifier)?.toFixed(4) ?? "?"}/M  ctx=${classifier.maxContextTokens ?? "?"}  [${kind(classifier)}]` +
        `  structuredOutput=${classifier.capabilities?.structuredOutput ?? "?"}` +
        `  tools=${classifier.capabilities?.toolCalling ?? "?"}`
      : ""),
);
console.log("cheapest 6 that pass the floors:");
for (const m of models
  .filter((m) => m.pricing.kind === "api" && m.pricing.inputPer1M.known)
  .filter((m) => (m.maxContextTokens ?? 0) >= defaultClassifierFloors.minContextTokens)
  .filter((m) => (m.supportsTools?.length ?? 0) > 0)
  .sort((a, b) => (price(a) ?? 9e9) - (price(b) ?? 9e9))
  .slice(0, 6)) {
  console.log(
    `  $${(price(m) ?? 0).toFixed(4)}/M  ${m.id}  [${kind(m)}]  json=${m.capabilities?.structuredOutput ?? "?"}`,
  );
}

// ---------------------------------------------------------------- 2
console.log("\n=== 2. routing matrix (live catalog) ===");
const tasks: Array<[string, TaskSpec]> = [
  ["rename variable", { objective: "Rename the variable total to orderTotal in the checkout module." }],
  ["add validation", { objective: "Add input validation to the HTTP client." }],
  ["pagination feature", { objective: "Implement pagination for the orders API endpoint.", risk: "medium" }],
  ["refactor handlers", { objective: "Refactor the duplicated authentication service.", risk: "medium" }],
  ["debug timeout", { objective: "Find the cause of the timeout in the worker service.", risk: "medium" }],
  ["deadlock debug", { objective: "Debug the intermittent deadlock in the distributed event pipeline.", risk: "high" }],
  ["migration plan", { objective: "Design a migration plan for the distributed event pipeline.", risk: "high" }],
  ["full rewrite", { objective: "Rewrite the billing service from scratch as a scalable event-driven system.", risk: "high" }],
];
console.log(["task", "complexity", "chosen", "$/M", "cap", "effort", "adm", "cands"].join("\t"));
for (const [label, task] of tasks) {
  const cls = keywordClassification(task);
  const d = route(task, models, cls, { capacity: snapshot.capacity, signals });
  console.log(
    [
      label,
      cls.complexity,
      d.model?.id ?? "none",
      d.model ? (price(d.model)?.toFixed(3) ?? "?") : "-",
      d.model?.capabilityScore?.toFixed(2) ?? "?",
      d.effort,
      d.admissionRequired ? "y" : "n",
      String(d.ranked.length),
    ].join("\t"),
  );
}

// ---------------------------------------------------------------- 3
console.log("\n=== 3. rename vs full rewrite ===");
for (const label of ["rename variable", "full rewrite"]) {
  const task = tasks.find(([l]) => l === label)![1];
  const cls = keywordClassification(task);
  const d = route(task, models, cls, { capacity: snapshot.capacity, signals });
  console.log(`${label}: inferred=${cls.complexity} score=${cls.score} matched=[${cls.matched?.join(" ") ?? ""}]`);
  console.log(`  -> ${d.model?.id} $${price(d.model!)?.toFixed(3)}/M cap=${d.model?.capabilityScore?.toFixed(2)}`);
  console.log(`  runners-up: ${d.ranked.slice(1, 4).map((r) => `${r.model.id} ${r.score.toFixed(3)}`).join(" | ")}`);
  if (task.objective.includes("Rewrite")) {
    const oracle = route({ ...task, complexity: "complex" }, models, keywordClassification({ ...task, complexity: "complex" }), {
      capacity: snapshot.capacity,
      signals,
    });
    console.log(`  with complexity=complex (oracle): ${oracle.model?.id} $${price(oracle.model!)?.toFixed(3)}/M`);
  }
}

// ---------------------------------------------------------------- 4
console.log("\n=== 4. models without a benchmark ===");
const unmeasured = models.filter((m) => m.capabilityScore === undefined);
console.log(`unmeasured: ${unmeasured.length}/${models.length}  (tier=unknown)`);
console.log("eligibility by complexity:");
for (const c of ["simple", "moderate", "complex"] as const) {
  const eligible = unmeasured.filter((m) => route({ objective: "x", complexity: c }, [m], keywordClassification({ objective: "x", complexity: c })).model !== null);
  console.log(`  ${c.padEnd(9)} ${eligible.length} of ${unmeasured.length} eligible`);
}
{
  const task: TaskSpec = { objective: "Rename the variable total to orderTotal in the checkout module." };
  const d = route(task, models, keywordClassification(task), { capacity: snapshot.capacity, signals });
  const bestUnmeasured = d.ranked.find((r) => r.model.capabilityScore === undefined);
  console.log(
    `best unmeasured for rename: ${bestUnmeasured?.model.id ?? "none"}` +
      (bestUnmeasured ? ` score=${bestUnmeasured.score.toFixed(3)} vs winner ${d.ranked[0].score.toFixed(3)} (${d.ranked[0].model.id})` : ""),
  );
}

// ---------------------------------------------------------------- 0
console.log("\n=== 0. the ladder (one representative task per rung) ===");
const rungs: Array<[Complexity, string]> = [
  ["trivial", "Rename the variable total to orderTotal in the checkout module."],
  ["simple", "Add input validation to the HTTP client."],
  ["moderate", "Refactor the duplicated authentication service into one helper."],
  ["advanced", "Implement pagination, filtering and sorting for the orders API."],
  ["complex", "Debug the intermittent deadlock in the distributed event pipeline."],
  ["frontier", "Rewrite the billing service from scratch as a scalable event-driven system."],
];
const showLadder = (label: string, capacity: Record<string, import("@vepando/switchyard-core").CapacityState>) => {
  console.log(`\n${label}`);
  console.log(["rung", "chosen", "$/M", "cap", "effort", "adm", "cands"].join("\t"));
  for (const [rung, objective] of rungs) {
    const t: TaskSpec = { objective, complexity: rung, risk: rung === "trivial" || rung === "simple" ? "low" : rung === "frontier" || rung === "complex" ? "high" : "medium" };
    const cls = keywordClassification(t);
    const d = route(t, models, cls, { capacity, signals });
    const p = d.model ? price(d.model, capacity) : undefined;
    console.log(
      [
        rung,
        d.model?.id ?? "none",
        p === undefined ? "?" : p.toFixed(3),
        d.model?.capabilityScore?.toFixed(2) ?? "?",
        d.effort,
        d.admissionRequired ? "y" : "n",
        String(d.ranked.length),
      ].join("\t"),
    );
  }
};
showLadder("with real codex quota (as measured):", snapshot.capacity);
const drained: Record<string, import("@vepando/switchyard-core").CapacityState> = { ...snapshot.capacity };
for (const id of ["codex-luna", "codex-terra", "codex-sol", "codex-astra"]) {
  drained[id] = { available: true, usage: { remainingFraction: 0.04, windowElapsedFraction: 0.85, source: "probe" } };
}
showLadder("with codex quota nearly drained:", drained);

// ---------------------------------------------------------------- 6
console.log("\n=== 6. cost of failure (30k context, realistic agent session) ===");
const CTX = 30_000;
for (const [label, task] of tasks.filter(([l]) =>
  ["rename variable", "full rewrite", "deadlock debug"].includes(l),
)) {
  for (const failureCost of [0, 5, 25, 100]) {
    const t: TaskSpec = { ...task, contextTokens: CTX, failureCostUsd: failureCost };
    const cls = keywordClassification(t);
    const d = route(t, models, cls, { capacity: snapshot.capacity, signals });
    const top = d.ranked[0];
    const exp = top?.expectedCostUsd;
    console.log(
      `${label.padEnd(18)} failure=$${String(failureCost).padStart(3)}  -> ${(d.model?.id ?? "none").padEnd(38)}` +
        ` pFail=${(top?.pFail ?? 0).toFixed(2)}  expected=$${(exp?.known ? exp.value.toFixed(2) : "?").padStart(6)}` +
        `  tokens=$${(top?.estCostUsd.known ? top.estCostUsd.value.toFixed(4) : "?")}`,
    );
  }
}

// ---------------------------------------------------------------- 5
console.log("\n=== 5. :free and :batch ===");
const free = models.filter((m) => m.freeTier);
const batch = models.filter((m) => m.id.endsWith(":batch"));
console.log(`:free  ${free.length} models   :batch ${batch.length} models`);
{
  const task: TaskSpec = { objective: "Debug the intermittent deadlock in the distributed event pipeline.", complexity: "complex", risk: "high" };
  const d = route(task, models, keywordClassification(task), { capacity: snapshot.capacity, signals });
  const ranked = d.ranked.slice(0, 8);
  console.log("top 8 for a complex task (note suffixes):");
  for (const r of ranked) {
    console.log(`  ${r.score.toFixed(3)}  $${(price(r.model) ?? 0).toFixed(3)}/M  ${r.model.id}  [${kind(r.model)}]`);
  }
  console.log(`winner is ${kind(d.model!)}`);
}
