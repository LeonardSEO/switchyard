# Switchyard

### Route every coding task to the model that is capable enough — without paying frontier prices for routine work.

[![npm version](https://img.shields.io/npm/v/@vepando/switchyard?logo=npm&color=cb3837)](https://www.npmjs.com/package/@vepando/switchyard)
[![CI](https://github.com/LeonardSEO/switchyard/actions/workflows/ci.yml/badge.svg)](https://github.com/LeonardSEO/switchyard/actions/workflows/ci.yml)
[![Node.js 20+](https://img.shields.io/badge/node-%3E%3D20-339933?logo=node.js&logoColor=white)](package.json)
[![Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

Switchyard is a subscription-aware model router for coding agents. It combines OpenRouter's live catalog with optional Codex subscription capacity, classifies the task, filters out unsuitable models, and minimizes the expected cost of getting a correct result.

One package supports [Pi](https://pi.dev), [OpenCode](https://opencode.ai), and any client that can use an OpenAI-compatible endpoint.

## Why Switchyard

- **Six routing levels, not three hard-coded models.** Tasks range from `trivial` to `frontier`, each with its own capability floor and reasoning effort.
- **A live model pool.** OpenRouter models are evaluated from current catalog metadata instead of a fixed shortlist. That includes model families from OpenAI, Anthropic, Google, DeepSeek, xAI, Qwen, Mistral, Meta, and others as they are available through OpenRouter.
- **Your Codex quota is a real resource.** Optional subscription capacity competes with API models based on remaining quota and time until reset; it is never treated as infinitely free.
- **Failure has a price.** Routing considers token cost, benchmark evidence, observed outcomes, and the estimated cost of a failed attempt.
- **The agent stays in control.** Switchyard selects a model and reasoning level. Your coding agent keeps its tools, permissions, MCP servers, session, and authentication.

## Install

### Pi

```bash
pi install npm:@vepando/switchyard
```

That is enough. The npm keyword `pi-package` makes the package eligible for the Pi package gallery as its index refreshes.

### OpenCode

```bash
npm install @vepando/switchyard
```

Add the plugin and provider to `opencode.json`:

```json
{
  "plugin": ["@vepando/switchyard"],
  "provider": {
    "switchyard": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Switchyard",
      "options": { "baseURL": "http://127.0.0.1:8787/v1" },
      "models": { "auto": { "name": "Switchyard Auto" } }
    }
  }
}
```

Choose `switchyard/auto`. The plugin starts the local gateway when needed.

### Cursor, Cline, aider, curl, and other clients

```bash
OPENROUTER_API_KEY=... npx @vepando/switchyard
```

Use `http://127.0.0.1:8787/v1` as the OpenAI-compatible base URL and select `switchyard/auto`.

## How routing works

```text
objective -> classify -> filter -> score expected cost -> select model + effort
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

OpenRouter supplies the primary model catalog, pricing, and execution path. Set `OPENROUTER_API_KEY`, or use credentials already available through the host integration.

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
| `failureCostByRisk` | Tune the penalty for an unsuccessful attempt at each risk level |
| `preferPaidCapacityFactor` | Control how much worse subscription capacity may score and still win; default `2` |
| `SWITCHYARD_PORT` | Gateway port; default `8787` |
| `SWITCHYARD_ESCALATION` | Gateway equivalent of the `escalation` option |

## Privacy and security

For classification, Switchyard sends only the latest user objective, capped at 4,000 characters. It does not add repository files or prior history to that classification call. The selected execution provider still receives the conversation and tool data that your client sends for the actual completion.

Set `escalation: "never"` to disable model-based classification. Credentials remain in the host or environment and are not written into Switchyard configuration. Please report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## Package architecture

Users install only `@vepando/switchyard`. The repository remains a workspace internally so the routing core, catalog, providers, gateway, and adapters can be tested independently; the release build bundles those modules into the single public package.

## Project status

Switchyard is early-stage software. The held-out classifier evaluation is promising but still small, and the optional Codex execution path relies on an undocumented backend. The gateway falls back to API routing when that backend is unavailable. Treat routing decisions as an optimization aid, not a guarantee of model quality or availability.

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
