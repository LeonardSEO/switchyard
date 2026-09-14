/**
 * Benchmark against the live catalog. Asserts properties, never model IDs.
 *
 *   npm run bench:live
 *
 * The deterministic corpus in eval/ proves the routing rules. This proves the
 * rules still hold when the catalog is 450 models we have never seen, and it
 * prints the current price/quality frontier so "which model is best value
 * today" is observable rather than hardcoded.
 */
import {
  effectiveInputPer1M,
  isParetoOptimal,
  keywordClassification,
  paretoFrontier,
  cheapestAboveQuality,
  route,
  type Complexity,
  type ModelCapabilities,
  type TaskSpec,
} from "@switchyard/core";
import { OpenRouterSource } from "@switchyard/provider-openrouter";
import {
  Catalog,
  CodexSubscriptionSource,
  OpenAICompatibleSource,
  detectCodexEnvironment,
  loadCodexModels,
  signalsFromCatalog,
} from "@switchyard/catalog";

const { models: codexModels, source: codexSource } = await loadCodexModels();
const codexEnv = await detectCodexEnvironment();

const catalog = new Catalog(
  [
    new OpenRouterSource(),
    new OpenAICompatibleSource({ id: "ollama", baseUrl: "http://localhost:11434/v1" }),
    new OpenAICompatibleSource({ id: "lm-studio", baseUrl: "http://localhost:1234/v1" }),
  ],
  new CodexSubscriptionSource(codexModels, codexEnv),
);
const snapshot = await catalog.refresh();
const signals = signalsFromCatalog(snapshot.models);

console.log(`catalog: ${snapshot.models.length} models (codex roster: ${codexSource})`);

/**
 * Effective price includes the subscription shadow price, so API and
 * subscription capacity are comparable on one axis. Quality is the published
 * capability multiplied by reliability: expected quality *per attempt*. A
 * rate-limited free tier does not dominate a reliable paid model, because you
 * do not get its score on the first try.
 */
const axes = {
  price: (m: ModelCapabilities) => {
    const p = effectiveInputPer1M(m, snapshot.capacity[m.id]);
    return p.known ? p.value : undefined;
  },
  quality: (m: ModelCapabilities) =>
    m.capabilityScore === undefined ? undefined : m.capabilityScore * (m.reliability ?? 1),
};

let failures = 0;
const check = (ok: boolean, label: string, detail: string) => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(28)} ${detail}`);
};

/** Quality floor implied by task complexity. Mirrors the tier filter. */
const FLOOR: Record<Complexity, number> = { simple: 0, moderate: 0.35, complex: 0.6 };

interface Case {
  label: string;
  task: TaskSpec;
  expectProviderNot?: string[];
  expectProviderIn?: string[];
}

const cases: Case[] = [
  { label: "trivial rename", task: { objective: "Rename the variable total to orderTotal in the checkout module." } },
  {
    label: "pagination feature",
    task: { objective: "Implement pagination for the orders API endpoint.", risk: "medium" },
  },
  {
    label: "hard debug (oracle complex)",
    task: {
      objective: "Debug the intermittent deadlock in the distributed event pipeline.",
      complexity: "complex",
      risk: "high",
    },
  },
  {
    label: "migration plan (oracle complex)",
    task: {
      objective: "Design a migration plan for the distributed event pipeline.",
      complexity: "complex",
      risk: "high",
    },
  },
  {
    label: "feature, quota drained",
    task: { objective: "Implement pagination for the orders API endpoint.", risk: "medium" },
    expectProviderNot: ["codex-subscription"],
  },
];

for (const c of cases) {
  const capacity = { ...snapshot.capacity };
  if (c.label.includes("quota drained")) {
    for (const id of ["codex-luna", "codex-terra", "codex-sol", "codex-astra"]) {
      capacity[id] = {
        available: true,
        usage: { remainingFraction: 0.05, windowElapsedFraction: 0.9, source: "bench" },
      };
    }
  }

  const cls = keywordClassification(c.task);
  const d = route(c.task, snapshot.models, cls, { capacity, signals });
  const chosen = d.model;
  const price = chosen ? axes.price(chosen) : undefined;

  console.log(
    `\n${c.label}  [${cls.complexity}]  -> ${chosen?.id ?? "none"}` +
      `  $${price === undefined ? "?" : price.toFixed(3)}/M` +
      `  capability=${chosen?.capabilityScore?.toFixed(2) ?? "?"}` +
      `  (${d.ranked.length} candidates)`,
  );

  check(!!chosen, "a model was chosen", chosen?.id ?? "none");
  if (!chosen) continue;

  const floor = FLOOR[cls.complexity];
  const cap = chosen.capabilityScore;
  if (floor > 0) {
    check(
      cap !== undefined && cap >= floor,
      `capability >= ${floor}`,
      `${cap?.toFixed(2) ?? "unmeasured"}`,
    );
  }

  const optimal = isParetoOptimal(chosen, d.ranked.map((r) => r.model), axes);
  check(optimal, "on the price/quality frontier", optimal ? "non-dominated" : "dominated");

  // Free tiers are excluded from the reference: \$0 makes any ratio meaningless.
  const paidPrices = d.ranked
    .map((r) => r.model)
    .filter((m) => !m.freeTier)
    .map(axes.price)
    .filter((p): p is number => p !== undefined);
  const cheapest = paidPrices.length ? Math.min(...paidPrices) : undefined;
  check(
    price === undefined || cheapest === undefined || price <= cheapest * 3,
    "within 3x of cheapest paid",
    `$${price?.toFixed(3) ?? "?"} vs $${cheapest?.toFixed(3) ?? "n/a"}`,
  );

  if (c.expectProviderNot) {
    check(
      !c.expectProviderNot.includes(chosen.provider),
      `not ${c.expectProviderNot.join("/")}`,
      chosen.provider,
    );
  }
  if (c.expectProviderIn) {
    check(c.expectProviderIn.includes(chosen.provider), `from ${c.expectProviderIn.join("/")}`, chosen.provider);
  }
}

// The frontier itself: what "best value" means today.
console.log("\n=== price/quality frontier (capability >= 0.35, cheapest first) ===");
const frontier = paretoFrontier(
  snapshot.models.filter((m) => (m.capabilityScore ?? 0) >= 0.35),
  axes,
);
console.log(["capability", "$/M in", "model"].join("\t"));
for (const m of frontier.slice(0, 14)) {
  const p = axes.price(m);
  console.log(
    `${(m.capabilityScore ?? 0).toFixed(2).padStart(9)}\t${(p === undefined ? "?" : p.toFixed(3)).padStart(7)}\t${m.id}`,
  );
}

console.log("\n=== cheapest model clearing each capability floor ===");
for (const floor of [0.35, 0.5, 0.6, 0.7]) {
  const best = cheapestAboveQuality(snapshot.models, floor, axes);
  const p = best ? axes.price(best) : undefined;
  console.log(
    `  >= ${floor.toFixed(2)}  ${best?.id ?? "none"}  $${p === undefined ? "?" : p.toFixed(3)}/M`,
  );
}

console.log(`\n${failures === 0 ? "all property checks passed" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
