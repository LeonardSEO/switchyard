# @vepando/switchyard-opencode

OpenCode plugin that routes every prompt through Switchyard — across
OpenRouter's live catalog (primary), with Codex subscription support when a
`codex login` is present.

```bash
npm i @vepando/switchyard-opencode
```

## Setup

Add the plugin and a Switchyard provider to `opencode.json` (a ready-made file
is in [`examples/opencode.json`](https://github.com/LeonardSEO/switchyard/blob/main/examples/opencode.json)):

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

Then pick model `switchyard/auto`. The plugin starts the gateway on first run
and prints the snippet above — no separate process to manage.

## How routing works

Routing happens in the gateway: the objective is classified into a rung, then
routed on price, benchmarks, measured quota and the cost of failure, with the
Pareto frontier deciding inside the capable band. The chosen model comes back
on the response:

```
x-switchyard-model: inclusionai/ling-3.0-flash
x-switchyard-complexity: trivial
```

Only the objective (the last user message, capped at 4000 characters) is used
for classification; files, context and history never leave your machine.

## License

[Apache-2.0](https://github.com/LeonardSEO/switchyard/blob/main/LICENSE)
