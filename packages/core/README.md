# @vepando/switchyard-core

Pure routing core for [Switchyard](https://github.com/LeonardSEO/switchyard):
classify, filter, score, decide. No I/O — no network, no filesystem, no
credentials. Everything is injected, which makes it fully deterministic and
trivially testable.

```bash
npm i @vepando/switchyard-core
```

## The model

```ts
import { route, keywordClassification, type ModelCapabilities } from "@vepando/switchyard-core";

const decision = route(
  { objective: "rewrite the billing service as an event-driven system" },
  models,               // ModelCapabilities[] — your candidate pool
  keywordClassification, // or a ModelClassifier
  { capacity, signals }, // measured quota and historical outcomes
);

decision.model;          // the pick (null when nothing survives: fail closed)
decision.effort;         // reasoning effort: "minimal" … "max"
decision.ranked;         // full ranking, with scores and expected costs
decision.pruned;         // every rejected candidate and why
decision.reason;         // one-line explanation
```

## Design principles

- **Six rungs, not three.** "Rename a variable" and "add a retry" are not the
  same class of work; the rung sets what a task *demands*, and demand is what a
  model has to clear.
- **Failure is priced.** Expected cost = token cost + probability of failure ×
  cost of failure. A botched rewrite costs an afternoon; tokens cost cents.
- **Unknown is never zero.** An unknown price, unknown quota or unknown
  capability is a distinct state, priced at its worst case — never treated as
  free or average.
- **Capability has a ceiling.** Beyond what a task demands, extra capability is
  noise, not value. Within that band the cheapest model wins.
- **Subscription capacity is priced, not free.** Amortized plan price, scaled
  by scarcity: nearly-drained quota is expensive, quota that would expire
  unused is nearly free.
- **History beats benchmarks, benchmarks beat nothing.** Per (model, task-kind)
  success rates override published scores once outcomes exist.

## Exports

`route`, `filterCandidates`, `scoreCandidate`, `keywordClassification`,
`ModelClassifier`, `pickCheapestClassifier`, `effortForComplexity`,
quota/effective-pricing helpers, Pareto-frontier utilities, and the full domain
type set.

## License

[Apache-2.0](https://github.com/LeonardSEO/switchyard/blob/main/LICENSE)
