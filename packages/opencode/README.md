# @vepando/switchyard-opencode

OpenCode plugin that routes every prompt through Switchyard — across OpenRouter's
catalog (primary), with Codex subscription support arriving later.

```bash
npm i @vepando/switchyard-opencode
```

`opencode.json` (a ready-made file is in [`examples/opencode.json`](https://github.com/LeonardSEO/switchyard/blob/main/examples/opencode.json)):

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

Then pick model `switchyard/auto`. The plugin starts the gateway on first run and
prints the snippet above.

Routing happens in the gateway: rungs, Pareto band, failure cost, with the chosen
model on `x-switchyard-model` and `x-switchyard-complexity`.

## Docs

Full documentation: https://github.com/LeonardSEO/switchyard#readme
