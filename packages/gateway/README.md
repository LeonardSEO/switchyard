# @vepando/switchyard-gateway

OpenAI-compatible endpoint that routes each request to the right model. Works
with OpenCode (custom provider), Cursor, Cline, aider, or plain curl — anything
that speaks the OpenAI API.

```bash
OPENROUTER_API_KEY=... npx @vepando/switchyard-gateway   # http://127.0.0.1:8787/v1
```

Point your tool at that URL and select model `switchyard/auto`.

## Per request

1. The last user message becomes the objective.
2. It is classified into one of six rungs.
3. It is routed across the live OpenRouter catalog.
4. The request is forwarded upstream with only the model changed.

Decisions come back on the response:

```
x-switchyard-model: inclusionai/ling-3.0-flash
x-switchyard-complexity: trivial
```

`?explain=1` returns the decision as JSON without executing it.

## Subscription capacity

With `codex login` present, the gateway treats Luna/Terra/Sol/Astra as candidates
and executes them on the Codex backend using that same login — no new keys. If
the backend fails, the request falls back to API routing instead of breaking.

Without a Codex login, everything routes over OpenRouter.

## Attribution

Forwards `X-Title` and `HTTP-Referer` on every upstream request, so your usage
ranks under Switchyard on OpenRouter. Override with `SWITCHYARD_APP_TITLE` and
`SWITCHYARD_APP_URL`.

## Docs

Full documentation: https://github.com/LeonardSEO/switchyard#readme
