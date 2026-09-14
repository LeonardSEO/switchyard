# @vepando/switchyard-catalog

The merged model pool for [Switchyard](https://github.com/LeonardSEO/switchyard):
one candidate list from every configured source, plus real measured quota.

```bash
npm i @vepando/switchyard-catalog
```

## What it assembles

`buildSnapshot()` returns models, per-model capacity and per-source status:

- **OpenRouter** — the live API catalog (prices, context windows, benchmark
  scores), via `@vepando/switchyard-provider-openrouter`.
- **Local endpoints** — any OpenAI-compatible server that lists models
  (Ollama and LM Studio are probed by default). Local weights are a known-zero
  price, not an unknown one.
- **Codex subscription** — when `codex login` is present. The roster
  (Luna/Terra/Sol/Astra) is declared, because OpenAI publishes no catalog for
  it, but each entry is *resolved against the OpenRouter catalog by name* so
  its capability comes from a published benchmark instead of a guess.
- **Real quota** — read from OpenAI's usage endpoint with the credential
  `codex login` already stored (CodexBar and a manual `~/.switchyard/
  codex-usage.json` are fallbacks). When nothing works, quota is reported as
  unknown — never invented.

Unknown price, unknown capability or unknown quota never drops a model: it is
priced at its worst case and filtered on what is actually known.

## Usage

```ts
import { buildSnapshot } from "@vepando/switchyard-catalog";

const snap = await buildSnapshot();
snap.models;    // ModelCapabilities[]
snap.capacity;  // Record<id, CapacityState>
snap.status;    // per-source counts and freshness notes
```

## License

[Apache-2.0](https://github.com/LeonardSEO/switchyard/blob/main/LICENSE)
