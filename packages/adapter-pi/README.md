# @vepando/switchyard

Pi package: route every turn to the model that should take it — across OpenRouter
(primary) and, optionally, the Codex subscription you already pay for.

```bash
pi install npm:@vepando/switchyard
```

Pi keeps its permissions, tools, MCP, sessions and authentication. This package
answers two questions per turn: **which model**, and **how hard it should think**
(`minimal` → `max`). Then it records what happened, so later turns route on
evidence instead of on prices.

## OpenRouter first

The catalog, prices and benchmark scores come from OpenRouter. You need an
OpenRouter key or an OpenRouter login Pi already has.

Codex support is optional: with `codex login` present, Switchyard reads your real
quota and adds Luna/Terra/Sol/Astra as candidates. Quota is priced, not assumed
free — nearly-drained quota is held back, with the last 10% of a window reserved.

## Configuration

Everything is optional.

- `escalation: "never"` — no classification calls; objectives stay local.
- `classifierModel: "<id>"` — pin the classifier.
- `failureCostByRisk` — cost of a failed attempt, per risk level.

## Attribution

Every request this package makes carries OpenRouter app attribution:

```http
HTTP-Referer: https://github.com/LeonardSEO/switchyard
X-Title: Switchyard
```

Overridable with `SWITCHYARD_APP_URL` and `SWITCHYARD_APP_TITLE`.

## Docs

Full documentation: https://github.com/LeonardSEO/switchyard#readme
