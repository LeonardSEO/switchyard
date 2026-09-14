/**
 * Fetches every available model from every configured source and reports what
 * the router would do with them.
 *
 *   npm run catalog            # refresh (uses cache inside the TTL)
 *   npm run catalog -- --force # ignore the cache
 */
import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { keywordClassification, route, type TaskSpec } from "@vepando/switchyard-core";
import { signalsFromCatalog, stats } from "@vepando/switchyard-catalog";
import { buildSnapshot } from "./build-catalog";

const force = process.argv.includes("--force");
const snapshot = await buildSnapshot({ force });

console.log("=== sources ===");
for (const s of snapshot.status) {
  console.log(
    `${s.source.padEnd(20)} ${String(s.count).padStart(5)} models${s.stale ? "  [STALE]" : ""}${s.note ? `  ${s.note}` : ""}`,
  );
}

console.log("\n=== codex subscription ===");
console.log(`quota: ${snapshot.usage.note}  [${snapshot.usage.source}]`);
for (const m of snapshot.matches) {
  console.log(
    `  ${m.id.padEnd(13)} capability=${m.capability?.toFixed(3) ?? "?"}  ${m.origin.padEnd(9)} ${m.matchedCatalogId ?? "(no catalog match)"}`,
  );
}

const s = stats(snapshot.models);
console.log("\n=== pool ===");
console.log(`total                 ${s.total}`);
console.log(`with coding benchmark ${s.withCapabilityScore}`);
console.log(`with known price      ${s.withKnownPrice}`);
console.log(`free variants         ${s.free}`);
console.log(`by tier               ${JSON.stringify(s.byTier)}`);

const signals = signalsFromCatalog(snapshot.models);
console.log("\n=== cold-start routing over the full pool ===");
const demos: Array<[string, TaskSpec]> = [
  ["rename", { objective: "Rename the variable total to orderTotal in the checkout module." }],
  ["feature", { objective: "Implement pagination for the orders API endpoint.", risk: "medium" }],
  [
    "hard debug",
    {
      objective: "Debug the intermittent deadlock in the distributed event pipeline.",
      complexity: "complex",
      risk: "high",
    },
  ],
  [
    "full rewrite",
    {
      objective: "Rewrite the billing service from scratch as a scalable event-driven system.",
      risk: "high",
    },
  ],
];
for (const [label, task] of demos) {
  const cls = keywordClassification(task);
  const d = route(task, snapshot.models, cls, { signals, capacity: snapshot.capacity });
  const cost = d.ranked[0]?.estCostUsd;
  console.log(
    `${label.padEnd(12)} ${cls.complexity.padEnd(9)} -> ${d.model?.id ?? "none"}` +
      `  est ${cost?.known ? `$${cost.value.toFixed(6)}` : "?"}  effort=${d.effort}` +
      `  (${d.ranked.length} candidates, ${d.pruned.length} pruned)`,
  );
}

const out = `${process.env.HOME ?? "."}/.switchyard/catalog.json`;
await mkdir(dirname(out), { recursive: true });
await writeFile(out, JSON.stringify(snapshot, null, 2));
console.log(`\nsnapshot written to ${out}`);
