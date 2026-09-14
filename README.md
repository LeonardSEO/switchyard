# Switchyard

Subscription-aware economic model router for coding agents. TypeScript, npm, no
binary, no Go subprocess.

Veto answers "which model is cheapest that might manage this?". Switchyard adds
the half that is missing everywhere: **subscription capacity has a price**, and
that price moves with how much quota is left and whether it will survive until
the reset.

Status: routing core + offline benchmark. No providers, no adapters, no network.

## Layout

```
packages/core/    pure routing: classify -> filter -> score -> decide. No I/O.
eval/             corpus (ported from veto + new quota scenarios) and benchmark
```

Everything in `packages/core` is a pure function. Providers inject a completion
function; nothing in the core opens a socket.

## The economics

Subscription models get a shadow price, not a free ride and not an API price:

```
effective = planAmortized
          * (1 + scarcityWeight * scarcity(remaining, elapsed))
          * (1 - expiring * expiringRelief)

scarcity = clamp01( (1 - remaining) * clamp(elapsed / remaining, 0.5, 2) / 2 )
expiring = clamp01( remaining - elapsed )     // quota likely to be wasted
```

- **ahead of pace** (quota draining faster than the window) -> expensive
- **on pace** -> full amortized price
- **behind pace** (quota will expire unused) -> nearly free

Unknown usage never becomes zero: it falls back to a conservative multiplier,
and an unknown amortized price stays unknown, which the scorer prices at the
worst-case cost fit. Known / unknown / zero are always distinct states.

### What the numbers actually say

This is the uncomfortable part, and it is why the benchmark exists. With real
OpenRouter prices (fetched live, cheapest first: granite-4.0-h-micro $0.017/M,
mistral-nemo $0.019/M, deepseek-v4-flash $0.035/M) and a plausible amortized
subscription price (~$0.30/M for a $20/month plan at ~66M tokens), **a cheap API
model beats subscription capacity on marginal cost in most states**. The
subscription wins when:

1. quota will expire unused anyway, or
2. the task needs large-tier quality that cheap models cannot deliver, or
3. there is no API key and no cash to spend.

"Sol costs me nothing because I already pay for Plus" is wrong in the way that
matters: the quota you spend now is quota you cannot spend on the hard task
tonight. It is cheap, not free. Routing on that difference is the product.

## Deliberate divergences from veto

| veto | switchyard | why |
|---|---|---|
| cost fit linear against an opus reference | log scale between $0.01/M and $15/M | almost every interesting model is now under $1/M; linearly they all score ~0.99 and a 10x price difference is invisible |
| unknown cost -> worst score | unknown cost -> worst score, but unknown *quota* keeps the amortized price | subscription capacity is not unknown-priced, it is unmeasured |
| one global success rate per model | per (model, kind) with global fallback | a model that fails at debugging is still the best choice for summarising |
| no capacity input | capacity filters and prices | the whole point |
| admission for every candidate | admission only on thin margins, complex tasks or high risk | admission costs a round trip per candidate |

Ported unchanged: complexity thresholds and kind adjustments, the
cheapest-viable-first weight distribution (cost .35, success .25, kind .20,
reject .10, eval .10), hard filter order, fail-closed when nothing survives.

## The classifier: deterministic by default

Keyword classification costs zero tokens and zero milliseconds. A model-backed
classifier exists as an escalation layer, gated on:

1. the deterministic answer being near a threshold, **and**
2. expected routing saving > 25x the classification cost, **and**
3. a per-task cost ceiling, plus caching and offline fallback.

The money argument favours always asking a model (classification is ~$0.00005,
one wrong route is ~$0.044 — a factor of 1000). Latency, availability and
privacy argue against it. Hence: cheap and instant by default, model-backed
only when the deterministic answer is genuinely unsure.

The classifier model is selected from the live catalog (cheapest that meets
context and capability floors), never hardcoded, and never a subscription
model — classification must not burn quota.

## Benchmark

```
npm run bench
```

| section | result | meaning |
|---|---|---|
| classifier accuracy | 5/10 | keyword inference is the weak link; this is the number an LLM classifier must beat |
| oracle-cold routing | 6/10 | with the correct complexity but no history, the router still picks unproven cheap models |
| oracle-warm routing | 6/6 | per-kind history fixes it |
| quota sensitivity | luna when quota expires unused, cheap API otherwise | the economic layer works |

The cold/warm gap is the argument for both history and the escalation
classifier. Do not ship a router that only has cold-start behaviour.

## Pi adapter

`@switchyard/adapter-pi` runs the router inside [pi](https://pi.dev). It does not
become the coding agent: pi keeps its permissions, tools, MCP, sessions and
authentication. The adapter only answers two questions per turn — which model,
and how hard it should think — then records what happened.

```
before_agent_start  -> classify the prompt, route, pi.setModel() + pi.setThinkingLevel()
agent_end           -> append the outcome to ~/.switchyard/outcomes.jsonl
```

Outcomes become per-`(model, kind)` success rates, which is what closes the gap
between cold-start routing (6/10 on the corpus) and routing on evidence (6/6).

Try it without touching your pi config:

```bash
pi -p "rename the variable total to orderTotal" \
  -e ~/Developer/switchyard/packages/adapter-pi/src/index.ts \
  --no-tools --no-session
```

Install it for real by adding the path to `~/.pi/agent/settings.json`:

```json
{ "extensions": ["/Users/leonard/Developer/switchyard/packages/adapter-pi/src/index.ts"] }
```

Two models are only ever chosen if pi can actually run them: the catalog is
intersected with `ctx.modelRegistry.getAvailable()`, so a model pi has no
credentials for is never selected. Codex subscription models are matched by name
against pi's Codex provider, and are skipped when that login is absent.

## Next


1. `@switchyard/provider-openrouter` — dynamic catalog, prices, capacity.
2. `@switchyard/adapter-pi` — `pi.registerProvider` + `before_provider_request`,
   no localhost gateway needed for pi.
3. `@switchyard/adapter-opencode` — npm plugin.
4. `@switchyard/gateway` — local `/v1` fallback for every other harness.
5. Quota sources: 429 + `retry-after`, manual `quota set`, local accounting.

## Attribution

Corpus scenarios marked `source: veto` are ported from
[github.com/oleg-koval/veto](https://github.com/oleg-koval/veto) (Apache-2.0).
Switchyard is Apache-2.0.
