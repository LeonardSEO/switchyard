/**
 * What has the router actually learned? Reads the outcome log and reports it.
 *
 *   npm run outcomes
 *
 * This is the whole point of recording outcomes: after a few sessions you can
 * see which models succeed at which kinds of work, whether the rungs are being
 * hit in sensible proportions, and where failures concentrate.
 */
import { readFileSync, existsSync } from "node:fs";

const path = `${process.env.HOME ?? "."}/.switchyard/outcomes.jsonl`;
if (!existsSync(path)) {
  console.log(`no outcomes yet at ${path}`);
  process.exit(0);
}

interface Outcome {
  modelId: string;
  kind: string;
  complexity: string;
  effort?: string;
  classifier?: string;
  success: boolean;
  at: number;
}

const outcomes: Outcome[] = readFileSync(path, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => {
    try {
      return JSON.parse(line) as Outcome;
    } catch {
      return undefined;
    }
  })
  .filter((o): o is Outcome => !!o);

if (outcomes.length === 0) {
  console.log("outcome log is empty");
  process.exit(0);
}

const pct = (n: number) => `${Math.round((n / outcomes.length) * 100)}%`;

console.log(`runs: ${outcomes.length}`);
const since = new Date(outcomes[0].at).toISOString().slice(0, 16);
console.log(`since ${since}\n`);

const group = <K>(key: (o: Outcome) => K) => {
  const map = new Map<K, { ok: number; total: number }>();
  for (const o of outcomes) {
    const k = key(o);
    const t = map.get(k) ?? { ok: 0, total: 0 };
    t.total += 1;
    if (o.success) t.ok += 1;
    map.set(k, t);
  }
  return [...map.entries()].sort((a, b) => b[1].total - a[1].total);
};

console.log("by model:");
for (const [model, t] of group((o) => o.modelId)) {
  console.log(`  ${String(model).padEnd(40)} ${t.ok}/${t.total}${t.ok < t.total ? "  <- failures" : ""}`);
}

console.log("\nby rung:");
for (const [rung, t] of group((o) => o.complexity)) {
  console.log(`  ${String(rung).padEnd(10)} ${pct(t.total).padStart(4)}  (${t.ok}/${t.total} ok)`);
}

console.log("\nby kind:");
for (const [kind, t] of group((o) => o.kind)) {
  console.log(`  ${String(kind).padEnd(12)} ${pct(t.total).padStart(4)}  (${t.ok}/${t.total} ok)`);
}

console.log("\nby classifier:");
for (const [classifier, t] of group((o) => o.classifier ?? "?")) {
  console.log(`  ${String(classifier).padEnd(20)} ${t.total}`);
}

const failures = outcomes.filter((o) => !o.success);
if (failures.length > 0) {
  console.log(`\nfailures: ${failures.length}`);
  for (const f of failures.slice(-5)) {
    console.log(`  ${new Date(f.at).toISOString().slice(0, 16)}  ${f.modelId}  ${f.complexity}/${f.kind}`);
  }
}
