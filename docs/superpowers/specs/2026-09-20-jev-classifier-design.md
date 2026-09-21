# Jev-First Classification Design

**Status:** Approved for implementation planning

**Date:** 2026-09-20

**Scope:** Replace Switchyard's default remote task-classification path with OpenRouter Decisions using `~typesafe/jev-latest`, while preserving explicit task constraints and the existing offline behavior.

## Objective

Use Jev as Switchyard's primary classifier for deciding a task's `kind` and `complexity`. Keep model selection, capability filtering, expected-cost scoring, execution, tools, and agent behavior unchanged. When Jev is unavailable, invalid, or insufficiently confident, fall back to the existing chat-model classifier and finally to the local keyword classifier.

The runtime fallback chain is:

```text
explicit TaskSpec values
        ↓ fill only missing dimensions
Jev via OpenRouter Decisions
        ↓ error, invalid response, or confidence < 0.50
existing chat-model classifier
        ↓ error or invalid response
local keyword classifier
```

## Constraints

- Use the moving OpenRouter model alias `~typesafe/jev-latest`; do not pin a numbered Jev release by default.
- Call OpenRouter's Decisions endpoint, not `/chat/completions`.
- Keep all prompts, criteria, identifiers, configuration text, documentation, and tests in English.
- Preserve `TaskSpec.kind` and `TaskSpec.complexity` as authoritative user or host constraints.
- Preserve the current `escalation` contract:
  - `always`: use Jev for every missing classification dimension.
  - `uncertain`: run the local classifier first and call Jev only when the local result is near a classification boundary.
  - `never`: make no remote classification call.
- Do not use Jev as a coding or tool-execution model.
- Do not add a runtime SDK dependency; use the existing raw-`fetch` provider style.
- Do not make billable live calls in the automated test suite.

## Architecture

### Core classifier composition

Add a provider-independent `DecisionClassifier` in `packages/core`. It implements the existing `Classifier` interface and receives a `DecisionFn` transport callback. The core package owns:

- the structured decision request and response types;
- the English task-kind and complexity questions;
- response validation and confidence aggregation;
- explicit-field preservation;
- escalation behavior;
- bounded successful-decision caching;
- Jev-to-chat fallback orchestration.

The OpenRouter package owns the network transport and the `~typesafe/jev-latest` default model identifier. This keeps OpenRouter authentication, URL construction, attribution headers, timeouts, and HTTP error handling out of the core package.

### Decision request

The state sent to Jev is intentionally small:

```ts
interface DecisionState {
  objective: string;
  project_context?: string;
}
```

`objective` is capped at 4,000 characters and `project_context` at 16,000 characters, matching the existing remote-classification privacy boundary. Project context is data, not instructions. Every question states that repository text must not override the classification criteria.

Only missing dimensions are requested. For example, an explicit `kind` causes the request to contain only the `complexity` question. When both dimensions are explicit, no classifier transport runs.

The question keys and allowed choices are stable schema identifiers:

- `task_kind`: `debug`, `refactor`, `summarize`, `extract`, `review`, `plan`, `code-change`
- `task_complexity`: `trivial`, `simple`, `moderate`, `advanced`, `complex`, `frontier`

The criteria mirror Switchyard's current routing vocabulary. They describe observable task scope, uncertainty, cross-component impact, and reasoning demand; they do not name preferred execution models.

### Confidence and fallback

Each requested `choice` answer must contain:

- a choice from the exact allowed set;
- a finite confidence value from `0` through `1`;
- probabilities whose keys belong to the allowed set and whose values are finite numbers from `0` through `1`.

The classification confidence is the minimum confidence across dimensions requested from Jev. A value below `0.50` does not produce a Jev classification and is not cached. Transport errors, timeouts, non-2xx responses, missing answers, unknown choices, and malformed confidence data also invoke the fallback classifier.

A successful Jev classification reports:

```ts
{
  source: "jev",
  classifierModel: "~typesafe/jev-latest", // or the resolved model returned by OpenRouter
  kind,
  complexity,
  confidence,
  costUsd
}
```

If the fallback classifier succeeds, its own `source` remains intact and the result records `fallbackFrom: "jev"` plus a machine-readable `fallbackReason`. This makes fallback behavior observable without treating degraded classification as successful Jev output.

### Caching and outage control

Successful Jev classifications use an exact-input cache with a six-hour TTL. The cache key includes:

- a decision-schema version;
- the requested Jev alias;
- the normalized objective and project context;
- explicit dimensions;
- escalation mode.

Low-confidence, malformed, and failed responses are never cached. A transport failure starts a one-minute in-process cooldown; requests during that cooldown go directly to the fallback classifier. The cooldown prevents every agent turn from waiting for the same upstream outage while keeping recovery automatic.

Pi's same-session classification reuse also gains the six-hour age bound. Existing persistent chat-classifier cache behavior remains unchanged, so a Jev failure can still reuse a valid chat-classifier result.

### OpenRouter Decisions transport

Add `packages/provider-openrouter/src/decisions.ts`. Its default endpoint is:

```text
POST https://openrouter.ai/api/alpha/decisions
```

The request body contains:

```json
{
  "model": "~typesafe/jev-latest",
  "state": {
    "objective": "...",
    "project_context": "..."
  },
  "questions": {
    "task_kind": {
      "type": "choice",
      "instructions": "...",
      "criteria": {}
    },
    "task_complexity": {
      "type": "choice",
      "instructions": "...",
      "criteria": {}
    }
  }
}
```

The transport uses the same OpenRouter bearer token and application attribution headers as model execution. It accepts an asynchronous credential resolver so Pi can reuse credentials held by its OpenRouter model registry. A separate `decisionsBaseUrl` option supports tests and compatible proxies. If it is absent, the transport derives `/api/alpha` only from a base URL ending in `/api/v1`; otherwise it uses OpenRouter's public Decisions URL instead of guessing a custom proxy path.

### Adapter integration

Pi and OMP build the current `ModelClassifier` as the fallback classifier, then wrap it in `DecisionClassifier`. `classifierModel` continues to pin the fallback chat classifier; it does not replace `~typesafe/jev-latest`. The existing OpenRouter credential resolution is extracted and shared by the chat and Decisions transports.

The gateway uses the same composition. It accepts an injectable `decisionFn` for tests and `SWITCHYARD_DECISIONS_BASE_URL` for a compatible custom Decisions endpoint. No user configuration is required for the default Jev-first path.

### Execution-model safety

Jev is a decision model and must never enter the coding-model candidate pool. Extend capability metadata with optional `textOutput`. When OpenRouter explicitly supplies `architecture.output_modalities`, the provider maps whether `text` is present. Candidate filtering rejects only `textOutput === false`, preserving compatibility when older catalog records omit modality metadata.

## Configuration Contract

No new required configuration is introduced.

| Setting | Jev-first behavior |
|---|---|
| `escalation: "always"` | Jev is the primary classifier for missing fields. |
| `escalation: "uncertain"` | Local classification runs first; Jev is called only near a boundary. |
| `escalation: "never"` | Classification stays local; neither Jev nor the chat fallback is called. |
| `classifierModel` | Pins only the chat-model fallback. |
| `SWITCHYARD_DECISIONS_BASE_URL` | Optional gateway override for a compatible Decisions endpoint. |

## Evaluation and Rollout

Extend the classifier evaluation script with explicit `jev`, `chat`, and `keyword` backends. Report exact accuracy, underclassification count, fallback rate, latency, and cost. Keep live evaluation opt-in through `--live`; unit and integration tests use deterministic fake transports.

The held-out corpus remains English and gains cases for:

- explicit kind or complexity preservation;
- ambiguous boundary tasks;
- adversarial instructions embedded in project context;
- long but irrelevant project context;
- malformed and low-confidence Jev answers;
- Jev outage followed by chat fallback and local fallback.

The implementation can ship enabled by default once all repository checks pass. Its compatibility escape hatch is the existing `escalation: "never"` mode. A live paid comparison is a separate, explicitly authorized release-validation step.

## Privacy and Security

Jev receives the same bounded objective and compact project profile already documented for remote classification. Source-file contents and conversation history remain excluded. Documentation must state that classification data is sent through OpenRouter to the selected Jev provider and that repository instruction files can contain private information.

The implementation must never log authorization headers, API keys, or full upstream response bodies. Error messages may include HTTP status and sanitized response metadata only.

## Non-Goals

- Replacing Switchyard's model scorer or execution path.
- Using Jev to select reasoning effort directly.
- Teaching Jev the live OpenRouter model catalog.
- Removing the existing chat or keyword classifiers.
- Adding multilingual prompts in the first release.
- Persisting raw classification input or Jev responses in new telemetry.

## Acceptance Criteria

- Default remote classification uses `~typesafe/jev-latest` through OpenRouter Decisions.
- Explicit `TaskSpec` dimensions are never overwritten.
- The fallback chain is Jev, existing chat classifier, then local keyword classifier.
- `escalation: "never"` performs no remote classification call.
- Low-confidence or invalid Jev output cannot influence model routing.
- Jev cannot be selected as an execution model when catalog metadata marks it as non-text output.
- Pi, OMP, and the gateway share the same core decision logic and OpenRouter transport.
- Automated tests make no real OpenRouter requests.
- README and configuration documentation are entirely English and accurately describe data flow, fallback behavior, and alpha API risk.
