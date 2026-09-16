# Switchyard

### Route every coding task to the model that is capable enough — without paying frontier prices for routine work.

[![npm version](https://img.shields.io/npm/v/@vepando/switchyard?logo=npm&color=cb3837)](https://www.npmjs.com/package/@vepando/switchyard)
[![CI](https://github.com/LeonardSEO/switchyard/actions/workflows/ci.yml/badge.svg)](https://github.com/LeonardSEO/switchyard/actions/workflows/ci.yml)
[![Node.js 20+](https://img.shields.io/badge/node-%3E%3D20-339933?logo=node.js&logoColor=white)](package.json)
[![Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

Switchyard is a subscription-aware model router for coding agents. It combines OpenRouter's live catalog with optional Codex subscription capacity, classifies the task, filters out unsuitable models, and minimizes the expected cost of getting a correct result.

One package supports [Pi](https://pi.dev), [Oh My Pi](https://omp.sh), [OpenCode](https://opencode.ai), and any client that can use an OpenAI-compatible endpoint.

## Why Switchyard

- **Six routing levels, not three hard-coded models.** Tasks range from `trivial` to `frontier`, each with its own capability floor and reasoning effort.
- **A live model pool.** OpenRouter models are evaluated from current catalog metadata instead of a fixed shortlist. That includes model families from OpenAI, Anthropic, Google, DeepSeek, xAI, Qwen, Mistral, Meta, and others as they are available through OpenRouter.
- **Your Codex quota is a real resource.** Optional subscription capacity competes with API models based on remaining quota and time until reset; it is never treated as infinitely free.
- **Failure has a price.** Routing considers token cost, benchmark evidence, observed outcomes, and the estimated cost of a failed attempt.
- **Complexity is codebase-aware in Pi.** The classifier sees a compact project profile, so the same request can route differently in a small app and a cross-service monorepo.
- **The agent stays in control.** Switchyard selects a model and reasoning level. Your coding agent keeps its tools, permissions, MCP servers, session, and authentication.

## Install

### Pi

```bash
pi install npm:@vepando/switchyard
```

That is enough. The npm keyword `pi-package` makes the package eligible for the Pi package gallery as its index refreshes.

Run `/switchyard-clear-cache` in Pi whenever you want to remove saved task
classifications. The next matching task will be classified again; model choices
are never stored in this cache.

### Oh My Pi (OMP)

```bash
omp plugin install @vepando/switchyard
```

Or add the repository as an OMP marketplace and install from its catalog:

```bash
omp plugin marketplace add LeonardSEO/switchyard
omp plugin install switchyard@switchyard
```

Restart OMP or run `/reload-plugins`. OMP's built-in `auto` thinking mode
selects reasoning effort for the current model; Switchyard additionally selects
the model using capability, price, context, measured outcomes, and optional
Codex capacity. Switchyard reuses OMP's available OpenRouter credentials and
compatible model entries; it does not yet route every provider supported by
OMP and does not replace its tools, sessions, or agent loop.

By default, Switchyard keeps routing every turn as before. To let OMP roles own
their pinned models and opt only selected work into Switchyard, start OMP with:

```bash
SWITCHYARD_ROUTING_SCOPE=selected-model omp
```

Then assign `switchyard/auto` to the worker roles that should be economically
routed. Planner, reviewer, prewalk, and other pinned roles remain untouched.

### OpenCode

```bash
opencode plugin @vepando/switchyard
```

Restart OpenCode and choose `switchyard/auto`. The plugin starts the local gateway and registers the provider automatically.
It reuses the OpenRouter API credential saved by OpenCode. An explicit `OPENROUTER_API_KEY` takes precedence.

Upgrading an existing installation? Run `opencode plugin @vepando/switchyard@latest --force` once so OpenCode refreshes its package cache.

For a manual project configuration, add only the plugin:

```json
{
  "plugin": ["@vepando/switchyard"]
}
```

### Cursor, Cline, aider, curl, and other clients

```bash
OPENROUTER_API_KEY=... npx @vepando/switchyard
```

Use `http://127.0.0.1:8787/v1` as the OpenAI-compatible base URL and select `switchyard/auto`.

## How routing works

```text
request + compact project context -> classify -> filter -> score expected cost -> select model + effort
```

| Level | Typical work | Reasoning effort |
|---|---|---|
| `trivial` | rename, typo, version bump | `minimal` |
| `simple` | focused change in one file | `low` |
| `moderate` | contained bug or multi-file feature | `medium` |
| `advanced` | new subsystem or cross-cutting refactor | `high` |
| `complex` | concurrency, migration, cross-service debugging | `xhigh` |
| `frontier` | greenfield architecture or core rewrite | `max` |

The scorer minimizes:

```text
expected cost = token cost + probability of failure x cost of failure
```

The selected model can therefore change as prices, capabilities, measured reliability, latency, context requirements, or subscription capacity change. Batch-only endpoints are excluded from interactive work. Tool-bearing gateway requests use API models until the Codex execution path can preserve the complete tool protocol safely.

## OpenRouter first, Codex optional

OpenRouter supplies the primary model catalog, pricing, and execution path. Set `OPENROUTER_API_KEY`, or let the OpenCode integration reuse OpenCode's saved OpenRouter credential.

If `codex login` is available, Switchyard can also consider supported Codex subscription models. Capacity that would otherwise expire is priced favorably; scarce capacity becomes expensive, and the final 10% is reserved. If subscription execution fails, Switchyard reroutes to a valid API model rather than forwarding an internal Codex identifier to OpenRouter.

Every OpenRouter request includes app attribution:

```http
HTTP-Referer: https://github.com/LeonardSEO/switchyard
X-Title: Switchyard
```

Forks can override these values with `SWITCHYARD_APP_URL` and `SWITCHYARD_APP_TITLE`.

## Configuration

All options are optional.

| Option | Purpose |
|---|---|
| `escalation` | `always` (default), `uncertain`, or `never`; use `never` to keep classification local |
| `classifierModel` | Pin the model used to classify tasks |
| `reuseSimilarity` | Control when a previous task classification may be reused; default `0.6` |
| `projectContext` | Pi: `auto` (default) or `none`; disable repository context while keeping model classification |
| `snapshotFreshnessMs` | Pi/OMP catalog and Codex-capacity refresh interval; default 10 minutes |
| `routingScope` | Pi/OMP: `global` (default) or `selected-model`; the latter routes only `switchyard/auto` |
| `admissionPolicy` | Pi/OMP: `notify` (default), `escalate`, or `ignore` when a route is complex, high-risk, or ambiguous |
| `buildTaskSpec` | Pi/OMP callback for constraints the host cannot infer, such as `risk`, `maxCostUsd`, or `skipModels` |
| `failureCostByRisk` | Tune the penalty for an unsuccessful attempt at each risk level |
| `preferPaidCapacityFactor` | Control how much worse subscription capacity may score and still win; default `2` |
| `SWITCHYARD_PORT` | Gateway port; default `8787` |
| `SWITCHYARD_ESCALATION` | Gateway equivalent of the `escalation` option |
| `SWITCHYARD_ROUTING_SCOPE` | Pi/OMP equivalent of `routingScope`; set `selected-model` for opt-in routing |

Pi and OMP record ordinary agent-loop completion as telemetry, not as proof that
the code is correct. Use `/switchyard-mark-success` after verification passes or
`/switchyard-mark-failure` after a rejected/failed result. Only explicit failures
and verified successes update learned model success rates. Outcome evidence is
recency-weighted and smoothed toward the benchmark prior until enough samples
exist. Complexity- and project-specific evidence is preferred only after at
least three verified outcomes, otherwise routing falls back to broader history.

## Privacy and security

In Pi and OMP, classification sends the latest user objective (up to 4,000 characters)
plus a compact project profile (up to 16,000 characters). The profile contains
the repository name, a shallow file tree, safe manifest metadata such as package
and script names, and project context files available to the host or discovered
locally, such as `AGENTS.md` or `CLAUDE.md`. It does not send source-file contents or conversation
history. Missing manifests or instruction files are simply omitted. Context
files can contain private project information; review them before enabling a
remote classifier, use `projectContext: "none"` to exclude them, or set
`escalation: "never"` to keep all classification local.

Outcome records stay local in `~/.switchyard/outcomes.jsonl`. Project-specific
learning stores a truncated hash of the project root, never the path itself.

The OpenCode and standalone gateway integrations currently classify only the
latest user objective, capped at 4,000 characters. The selected execution
provider still receives the conversation and tool data that the client sends
for the actual completion.

Set `escalation: "never"` to disable model-based classification. Credentials remain in the host or environment and are not written into Switchyard configuration. Please report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## Package architecture

Users install only `@vepando/switchyard`. The repository remains a workspace internally so the routing core, catalog, providers, gateway, and adapters can be tested independently; the release build bundles those modules into the single public package.

## Project status

Switchyard is early-stage software. The held-out classifier evaluation is promising but still small, and the optional Codex execution path relies on an undocumented backend. The gateway falls back to API routing when that backend is unavailable. Treat routing decisions as an optimization aid, not a guarantee of model quality or availability.

## Contributors

Special thanks to [Tai Benvenuti (@taibenvenuti)](https://github.com/taibenvenuti),
recognized as an **Early contributor — Routing & Reliability** for detailed
technical reviews that strengthened classification, Pi/OMP routing contracts,
admission handling, and outcome learning.

See [CONTRIBUTORS.md](CONTRIBUTORS.md) for contributor acknowledgements and how
to get involved.

## Development

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run pack:check
```

Contributions are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[Apache-2.0](LICENSE)
