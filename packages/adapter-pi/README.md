# Switchyard

### One subscription-aware model router for Pi, Oh My Pi, OpenCode, and OpenAI-compatible coding agents.

[![npm version](https://img.shields.io/npm/v/@vepando/switchyard?logo=npm&color=cb3837)](https://www.npmjs.com/package/@vepando/switchyard)
[![CI](https://github.com/LeonardSEO/switchyard/actions/workflows/ci.yml/badge.svg)](https://github.com/LeonardSEO/switchyard/actions/workflows/ci.yml)
[![Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](https://github.com/LeonardSEO/switchyard/blob/main/LICENSE)

Switchyard routes each coding task to a capable model without spending frontier-model prices on routine work. It evaluates OpenRouter's live catalog and optional Codex subscription capacity using capability, price, context, measured outcomes, quota, and the expected cost of failure.

In Pi, the task classifier also receives a compact repository profile: project
structure, safe package metadata, and available `AGENTS.md` or `CLAUDE.md`
context. This lets the same request receive a different complexity rating in a
small app than in a cross-service monorepo. Missing context files are optional.

## Install

### Pi

```bash
pi install npm:@vepando/switchyard
```

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
selects reasoning effort for the current model. Switchyard additionally selects
the model using capability, price, context, measured outcomes, and optional
Codex capacity. It reuses OMP's available OpenRouter credentials and compatible
model entries; it does not yet route every provider supported by OMP.

### OpenCode

```bash
opencode plugin @vepando/switchyard
```

Restart OpenCode and choose `switchyard/auto`. Switchyard starts its local gateway and registers the provider automatically.
It reuses the OpenRouter API credential saved by OpenCode. An explicit `OPENROUTER_API_KEY` takes precedence.

Upgrading an existing installation? Run `opencode plugin @vepando/switchyard@latest --force` once so OpenCode refreshes its package cache.

Manual project configuration only needs the plugin entry:

```json
{
  "plugin": ["@vepando/switchyard"]
}
```

### Other OpenAI-compatible clients

```bash
OPENROUTER_API_KEY=... npx @vepando/switchyard
```

Point the client at `http://127.0.0.1:8787/v1` and select `switchyard/auto`.

## Six routing levels, a live model pool

Switchyard does not route three examples to three fixed models. It classifies work across six levels and selects from models currently available in the catalog.

| Level | Typical work | Effort |
|---|---|---|
| `trivial` | rename, typo, version bump | `minimal` |
| `simple` | focused one-file change | `low` |
| `moderate` | contained bug or multi-file feature | `medium` |
| `advanced` | subsystem or cross-cutting refactor | `high` |
| `complex` | concurrency, migration, cross-service debugging | `xhigh` |
| `frontier` | greenfield architecture or core rewrite | `max` |

```text
expected cost = token cost + probability of failure x cost of failure
```

The model can change as pricing, capability evidence, reliability, latency, context requirements, and available subscription capacity change.

## OpenRouter first, Codex optional

Set `OPENROUTER_API_KEY` or let the OpenCode integration reuse OpenCode's saved OpenRouter credential. When `codex login` is available, supported Codex subscription models can join the candidate pool. Switchyard favors capacity that would otherwise expire, makes scarce capacity more expensive, and reserves the final 10%.

## Privacy

Classification sends the latest user objective (up to 4,000 characters) and a
compact project profile (up to 16,000 characters). The profile contains a
shallow file tree, safe manifest metadata, and Pi-loaded project context such as
`AGENTS.md`; it does not include source-file contents or conversation history.
Because context files can contain private project information, review them
before using a remote classifier. Set `projectContext: "none"` to classify only
the objective, or `escalation: "never"` to keep classification local. The chosen
execution provider still receives the messages and tool data sent by the client
for the actual completion.

## Requirements and status

Node.js 20+ and OpenRouter credentials are required; Codex login is optional. Switchyard is early-stage software. The optional Codex path uses an undocumented backend and falls back to API routing when unavailable.

Full documentation, configuration, architecture, security policy, and contribution guide are available in the [GitHub repository](https://github.com/LeonardSEO/switchyard).

## License

Copyright 2026 Leonard van Hemert. Licensed under
[Apache-2.0](https://github.com/LeonardSEO/switchyard/blob/main/LICENSE).
Third-party attribution for the limited portions derived from veto is
documented separately in [NOTICE](https://github.com/LeonardSEO/switchyard/blob/main/NOTICE).
