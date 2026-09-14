/**
 * Fetches every available model from every configured source and reports what
 * the router would do with them.
 *
 *   npm run catalog            # refresh (uses cache inside the TTL)
 *   npm run catalog -- --force # ignore the cache
 */
import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { keywordClassification, route, type TaskSpec } from "@switchyard/core";
import { OpenRouterSource } from "@switchyard/provider-openrouter";
import {
  Catalog,
  CodexSubscriptionSource,
  OpenAICompatibleSource,
  detectCodexEnvironment,
  signalsFromCatalog,
  stats,
} from "@switchyard/catalog";

const force = process.argv.includes("--force");

const sources = [
  new OpenRouterSource(),
  // Present on many machines, zero cost per token when it is.
  new OpenAICompatibleSource({ id: "ollama", baseUrl: "http://localhost:11434/v1" }),
  new OpenAICompatibleSource({ id: "lm-studio", baseUrl: "http://localhost:1234/v1" }),
];

const codexEnv = await detectCodexEnvironment();
const codex = new CodexSubscriptionSource(undefined, codexEnv);

const catalog = new Catalog(sources, codex);
const snapshot = await catalog.refresh(force);

console.log("=== sources ===");
for (const s of snapshot.status) {
  console.log(
    `${s.source.padEnd(20)} ${String(s.count).padStart(5)} models${s.stale ? "  [STALE]" : ""}${s.note ? `  ${s.note}` : ""}`,
  );
}

const s = stats(snapshot.models);
console.log("\n=== pool ===");
console.log(`total                 ${s.total}`);
console.log(`with coding benchmark ${s.withCapabilityScore}`);
console.log(`with known price      ${s.withKnownPrice}`);
console.log(`free variants         ${s.free}`);
console.log(`by tier               ${JSON.stringify(s.byTier)}`);
console.log("cheapest per tier:");
for (const [tier, c] of Object.entries(s.cheapestPerTier)) {
  console.log(`  ${tier.padEnd(8)} ${c ? `${c.id} $${c.usdPer1M.toFixed(3)}/M` : "-"}`);
}

// Cold-start routing across the whole pool: benchmark scores are the only
// quality signal available on a fresh install.
const signals = signalsFromCatalog(snapshot.models);
const demos: Array<[string, TaskSpec]> = [
  ["rename", { objective: "Rename the variable total to orderTotal in the checkout module." }],
  [
    "feature",
    { objective: "Implement pagination for the orders API endpoint.", risk: "medium" },
  ],
  [
    "hard debug",
    {
      objective: "Debug the intermittent deadlock in the distributed event pipeline.",
      risk: "high",
    },
  ],
];

console.log("\n=== cold-start routing over the full pool ===");
for (const [label, task] of demos) {
  const cls = keywordClassification(task);
  const d = route(task, snapshot.models, cls, { signals, capacity: snapshot.capacity });
  const cost = d.ranked[0]?.estCostUsd;
  console.log(
    `${label.padEnd(11)} ${cls.complexity.padEnd(9)} -> ${d.model?.id ?? "none"}` +
      `  est ${cost?.known ? `$${cost.value.toFixed(6)}` : "?"}  effort=${d.effort}` +
      `  admission=${d.admissionRequired ? "y" : "n"}  (${d.ranked.length} candidates, ${d.pruned.length} pruned)`,
  );
}

const out = `${process.env.HOME ?? "."}/.switchyard/catalog.json`;
await mkdir(dirname(out), { recursive: true });
await writeFile(out, JSON.stringify(snapshot, null, 2));
console.log(`\nsnapshot written to ${out}`);
