# @vepando/switchyard

A [pi](https://pi.dev) package that routes every turn to the right model —
including the Codex or Claude subscription you already pay for.

Switchyard does not become the coding agent. Pi keeps its permissions, tools,
MCP, sessions and authentication. The adapter answers two questions per turn:
which model, and how hard it should think. Then it records what happened, so
later turns route on evidence instead of on prices.

```bash
pi install npm:@vepando/switchyard
```

## What it decides

| rung | what it picks (API prices, your catalog will differ) |
|---|---|
| trivial | cheapest capable model |
| simple | flash class |
| moderate | large flash class |
| advanced | pro class |
| complex | top tier, or your subscription when it lasts |
| frontier | frontier band, or your subscription when it lasts |

Subscription capacity is priced, not assumed free: quota that will expire unused
is cheap, quota that displaces other work is not, and the last 10% of a window is
held back. Batch endpoints are excluded from interactive work.

## Configuration

Everything is optional. Defaults: classify each task with a cheap model
(measured 11/12 against 2/12 for keyword rules), cache on disk, and fall back to
the deterministic answer if the call fails.

- `escalation: "never"` keeps every objective on the machine.
- `classifierModel: "some/model"` pins the classifier.

## Requirements

Node 20+. A model provider Pi can already use (OpenRouter, Codex, Anthropic).
No new credentials: the adapter borrows Pi's own.
