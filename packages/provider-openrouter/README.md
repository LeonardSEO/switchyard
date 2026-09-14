# @vepando/switchyard-provider-openrouter

OpenRouter catalog source for [Switchyard](https://github.com/LeonardSEO/switchyard):
live prices, context windows, declared capabilities and benchmark scores for
~500 models, mapped onto the router's `ModelCapabilities` type.

```bash
npm i @vepando/switchyard-provider-openrouter
```

## Features

- **ETag-cached** full catalog on disk (`~/.switchyard/openrouter.json`, 6h
  TTL) — 304 responses cost nothing, and routing never depends on a live HTTP
  call: stale data is served rather than failing when the network is down.
- **Capability from benchmarks.** Artificial Analysis coding indices are
  normalised to 0..1 and drive the tier thresholds (large ≥ 0.60, mid ≥ 0.35).
  Roughly a third of the catalog lands in each band.
- **Honest metadata.** Free and batch variants are detected and flagged; free
  tiers carry a reliability discount because a rate-limited model that needs
  three retries is not cheap. Unsupported tool calling is recorded as a known
  weakness instead of an unknown.

## Usage

```ts
import { OpenRouterSource } from "@vepando/switchyard-provider-openrouter";

const source = new OpenRouterSource({ apiKey: process.env.OPENROUTER_API_KEY });
const { models } = await source.list();
```

## License

[Apache-2.0](https://github.com/LeonardSEO/switchyard/blob/main/LICENSE)
