# Switchyard

**A subscription-aware model router for coding agents.**

Every coding turn gets routed to the model that should actually take it — across
OpenRouter's live catalog (500+ models) and, optionally, the Codex subscription
you already pay for. The decision is made on price, published benchmarks, and
the cost of getting it wrong. Not on a cost tier you have to pick yourself.

```
"rename the variable total to orderTotal"                 → trivial   → cheap flash, effort minimal
"add pagination to the orders API"                        → moderate  → large flash
"rewrite the billing service as an event-driven system"   → frontier  → top tier, or your Codex quota
```

## Install

Switchyard runs as a [Pi](https://pi.dev) package, an OpenCode plugin, or a local
endpoint for anything else.

### Pi

```bash
pi install npm:@vepando/switchyard
```

Pi keeps its own permissions, tools, MCP, sessions and authentication. Switchyard
only answers two questions per turn: which model, and how hard it should think.

### OpenCode

```bash
npm i @vepando/switchyard-opencode
```

Then, in `opencode.json` (a ready-made file is in [`examples/opencode.json`](examples/opencode.json)):

```json
{
  "plugin": ["@vepando/switchyard-opencode"],
  "provider": {
    "switchyard": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Switchyard",
      "options": { "baseURL": "http://127.0.0.1:8787/v1" },
      "models": { "auto": { "name": "Switchyard auto" } }
    }
  }
}
```

Pick model `switchyard/auto`. The plugin starts the gateway for you.

### Any other tool (Cursor, Cline, aider, curl)

```bash
OPENROUTER_API_KEY=... npx @vepando/switchyard-gateway   # http://127.0.0.1:8787/v1
```

Point your tool at that URL with model `switchyard/auto`.

## OpenRouter first, Codex optional

**Switchyard is built around OpenRouter.** That is where the catalog, the prices
and the benchmark scores come from, and where most routing decisions are made.
You need an OpenRouter API key (or an OpenRouter login your harness already has).

Codex subscription support is **optional** and works in both the Pi adapter and
the gateway: if you are logged into ChatGPT via `codex login`, Switchyard reads
your real quota and treats Luna/Terra/Sol/Astra as candidates alongside the API
catalog. Execution then happens on the Codex backend with that same login — no
new keys. Without the login, nothing changes: everything routes over OpenRouter.

Subscription capacity is priced, never assumed free:

| quota state | what it costs the router |
|---|---|
| will expire unused | nearly free — spend it |
| on pace | full amortized price |
| nearly drained | expensive — held back, with the last 10% reserved |

## How a turn is routed

1. **Objective** — the last user message (nothing else leaves your machine).
2. **Classify** into one of six rungs, with a cheap model by default.
3. **Filter** — capability floor, tier, context, tools, quota; batch endpoints are
   excluded from interactive work.
4. **Score** — expected cost = token cost + probability of failure × cost of failure.
5. **Pick** — the cheapest model inside the capable band.

| rung | example | reasoning effort |
|---|---|---|
| trivial | rename, typo, bump a version | minimal |
| simple | small change in one file | low |
| moderate | multi-file feature, contained bug | medium |
| advanced | new subsystem, cross-cutting refactor | high |
| complex | concurrency, migration, cross-service debugging | xhigh |
| frontier | greenfield architecture, core rewrite | max |

Failure is priced because a botched rewrite costs an afternoon while tokens cost
cents. That single choice is why a full rewrite goes to the frontier and a rename
does not.

## Accuracy

| | fitting set | held-out set |
|---|---|---|
| keyword rules | 9/10 | **2/12** |
| model classification | 7/10 | **11/12** |

The 9/10 was overfitting; on tasks the rules were never tuned for they collapse.
So classification uses a cheap model by default: one call per *task* (not per
turn), cached on disk, with the deterministic answer as offline fallback.

## OpenRouter attribution

OpenRouter ranks apps and agents by attributed traffic — there is no submission
form. Switchyard therefore sends these on every request it makes, under any harness:

```http
HTTP-Referer: https://github.com/LeonardSEO/switchyard
X-Title: Switchyard
```

Forking this? Set `SWITCHYARD_APP_TITLE` and `SWITCHYARD_APP_URL` so your traffic
ranks under your own name.

## Configuration

Everything is optional.

- `escalation: "never"` — no classification calls; every objective stays local.
- `classifierModel: "<id>"` — pin the classifier instead of letting price,
  benchmark and measured latency decide.
- `failureCostByRisk` — what a failed attempt costs you, per risk level.
- `preferPaidCapacityFactor` — how much worse subscription capacity may be and
  still win (default 2×).

## Packages

| package | role |
|---|---|
| [`@vepando/switchyard`](packages/adapter-pi) | the Pi package |
| [`@vepando/switchyard-opencode`](packages/opencode) | OpenCode plugin |
| [`@vepando/switchyard-gateway`](packages/gateway) | OpenAI-compatible endpoint for any tool |
| [`@vepando/switchyard-core`](packages/core) | pure routing core |
| [`@vepando/switchyard-catalog`](packages/catalog) | merged model pool, real quota |
| [`@vepando/switchyard-provider-openrouter`](packages/provider-openrouter) | live OpenRouter catalog |

## Privacy

Classification sends **only the objective** — your prompt text, capped at 4000
characters. Never your files, repository context, or history. Run `escalation:
"never"` to keep everything local.

## Requirements

Node 20+. An OpenRouter key. Optionally `codex login` for subscription capacity
in Pi.

## Status

Early. The eval corpus is small (10 fitting + 12 held-out), so accuracy figures
are indicative. The Codex execution path uses an undocumented backend: it falls
back to API routing if that backend ever changes. Only Pi and OpenCode are
supported today.

## License

[Apache-2.0](LICENSE)
