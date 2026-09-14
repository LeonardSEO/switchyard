# @vepando/switchyard

Switchyard as a Pi package: route every turn to the model that should take it —
across OpenRouter (primary) and, optionally, the Codex subscription you already
pay for.

```bash
pi install npm:@vepando/switchyard
```

## What it does

Pi keeps its permissions, tools, MCP, sessions and authentication. On every turn
this package answers exactly two questions:

1. **Which model** should take this turn?
2. **How hard should it think?** — reasoning effort from `minimal` to `max`.

Then it records what happened, so later turns route on evidence instead of on
prices alone. Most turns classify with a cheap model call that is cached on
disk; classification sends only the objective, capped at 4000 characters —
never your files, repository context or history. Set `escalation: "never"` to
keep everything local and deterministic.

## OpenRouter first, Codex optional

The catalog, prices and benchmark scores come from OpenRouter; you need an
OpenRouter key or an OpenRouter login Pi already has.

Codex support activates automatically when `codex login` is present: Switchyard
reads your real quota and adds Luna/Terra/Sol/Astra as candidates alongside the
API catalog. Quota is priced, never assumed free — capacity that will expire
unused is nearly free, while the last 10% of a window is reserved.

## Configuration

Everything is optional.

- `escalation` — `"always"` (default), `"uncertain"`, or `"never"` for offline
  and private use.
- `classifierModel: "<id>"` — pin the classifier instead of letting price,
  benchmark and measured latency decide.
- `reuseSimilarity` — word-overlap (0..1) above which the previous task's rung
  is reused. Default 0.6: strict, so a rename is classified as its own task and
  can drop to a cheaper model instead of inheriting the previous rung. Lower it
  to run the classifier less; raise it to run it on nearly every turn.
- `failureCostByRisk` — what a failed attempt costs you, per risk level.
- `outcomeFile`, `cacheFile` — custom paths for the outcome log and
  classification cache (defaults live under `~/.switchyard/`).

## What you see

A notification per decision, e.g.:

```
switchyard → deepseek/deepseek-v4-flash (moderate, effort medium, $0.060/M)
```

## Attribution

Every upstream request carries OpenRouter app attribution:

```http
HTTP-Referer: https://github.com/LeonardSEO/switchyard
X-Title: Switchyard
```

Overridable with `SWITCHYARD_APP_URL` and `SWITCHYARD_APP_TITLE`.

## Requirements

Node 20+, Pi. An OpenRouter key; optionally `codex login`.

## License

[Apache-2.0](https://github.com/LeonardSEO/switchyard/blob/main/LICENSE)
