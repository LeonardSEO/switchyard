# @vepando/switchyard-opencode

OpenCode plugin that routes every prompt through Switchyard.

```bash
opencode            # plugin starts the gateway on first run
```

Add to `opencode.json`:

```json
{
  "plugin": ["@vepando/switchyard-opencode"]
}
```

Then add the provider once (the plugin prints this on startup) and pick model
`switchyard/auto`:

```json
{
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

A ready-made config lives in `examples/opencode.json`.

Routing then happens in the gateway: rungs, Pareto band, failure cost, and
subscription capacity when it lasts — with the chosen model on the response
headers.
