# @vepando/switchyard-gateway

An OpenAI-compatible endpoint that routes each request to the right model.

Not every coding harness has a hook rich enough to choose a model per request.
Any tool that can talk to an OpenAI-compatible API can use this instead:
OpenCode (custom provider), Cursor, Cline, aider, or plain curl.

```bash
OPENROUTER_API_KEY=... npx @vepando/switchyard-gateway   # http://127.0.0.1:8787/v1
```

Then point your tool at `http://127.0.0.1:8787/v1` and select model
`switchyard/auto`.

## What it does per request

1. Takes the last user message as the objective.
2. Classifies it into one of six rungs (AI by default, deterministic fallback).
3. Routes across the live catalog, including subscription capacity when it lasts.
4. Forwards the request upstream unchanged apart from the model.

Responses carry the decision:

```
x-switchyard-model: inclusionai/ling-3.0-flash
x-switchyard-complexity: trivial
```

Add `?explain=1` to get the decision as JSON without executing it.

## Limits

The gateway routes across API providers. Subscription capacity inside the
gateway is not wired up yet; the Pi adapter uses Codex subscriptions directly.
