# @vepando/switchyard-gateway

OpenAI-compatible endpoint that routes each request to the right model. Works
with OpenCode (custom provider), Cursor, Cline, aider, or plain curl — anything
that speaks the OpenAI API.

```bash
OPENROUTER_API_KEY=... npx @vepando/switchyard-gateway   # http://127.0.0.1:8787/v1
```

Point your tool at that URL and select model `switchyard/auto`.

Port: `SWITCHYARD_PORT` env var, the first CLI argument, or 8787.
Classification escalation: `SWITCHYARD_ESCALATION` (`always` default,
`uncertain`, or `never` for fully local decisions).

## Per request

1. The last user message becomes the objective — nothing else leaves your
   machine, and it is capped at 4000 characters.
2. It is classified into one of six rungs (trivial → frontier) by a cheap model,
   cached, with a deterministic offline fallback.
3. It is routed across the live OpenRouter catalog (and Codex subscription
   capacity when available).
4. The request is forwarded upstream with only the model changed — tools,
   schemas and history pass through untouched.

Decisions come back on the response:

```
x-switchyard-model: inclusionai/ling-3.0-flash
x-switchyard-complexity: trivial
```

`?explain=1` returns the decision as JSON without executing it. `/healthz`
reports catalog freshness. `/v1/models` lists the pool.

## Subscription capacity

With `codex login` present, the gateway treats Luna/Terra/Sol/Astra as
candidates and executes them on the Codex backend using that same login — no
new keys, no scraping, and real quota is read from OpenAI's usage endpoint so
the router knows what the subscription actually has left. If the backend fails,
the request falls back to API routing instead of breaking the turn.

Without a Codex login, everything routes over OpenRouter.

## Attribution

Upstream requests forward `X-Title` and `HTTP-Referer` so OpenRouter attributes
your traffic to Switchyard. Forking? Override with `SWITCHYARD_APP_TITLE` and
`SWITCHYARD_APP_URL`.

## Requirements

Node 20+. An OpenRouter API key.

## License

[Apache-2.0](https://github.com/LeonardSEO/switchyard/blob/main/LICENSE)
