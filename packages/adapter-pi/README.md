# Switchyard

### One subscription-aware model router for Pi, OpenCode, and OpenAI-compatible coding agents.

[![npm version](https://img.shields.io/npm/v/@vepando/switchyard?logo=npm&color=cb3837)](https://www.npmjs.com/package/@vepando/switchyard)
[![CI](https://github.com/LeonardSEO/switchyard/actions/workflows/ci.yml/badge.svg)](https://github.com/LeonardSEO/switchyard/actions/workflows/ci.yml)
[![Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](https://github.com/LeonardSEO/switchyard/blob/main/LICENSE)

Switchyard routes each coding task to a capable model without spending frontier-model prices on routine work. It evaluates OpenRouter's live catalog and optional Codex subscription capacity using capability, price, context, measured outcomes, quota, and the expected cost of failure.

## Install

### Pi

```bash
pi install npm:@vepando/switchyard
```

### OpenCode

```bash
npm install @vepando/switchyard
```

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

Choose `switchyard/auto` after restarting OpenCode.

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

Set `OPENROUTER_API_KEY` or use credentials exposed by the host. When `codex login` is available, supported Codex subscription models can join the candidate pool. Switchyard favors capacity that would otherwise expire, makes scarce capacity more expensive, and reserves the final 10%.

## Privacy

Classification sends only the latest user objective, capped at 4,000 characters. It does not add files or conversation history. The chosen execution provider still receives the messages and tool data sent by the client for the actual completion. Set `escalation: "never"` to keep classification local.

## Requirements and status

Node.js 20+ and OpenRouter credentials are required; Codex login is optional. Switchyard is early-stage software. The optional Codex path uses an undocumented backend and falls back to API routing when unavailable.

Full documentation, configuration, architecture, security policy, and contribution guide are available in the [GitHub repository](https://github.com/LeonardSEO/switchyard).

## License

[Apache-2.0](https://github.com/LeonardSEO/switchyard/blob/main/LICENSE)
