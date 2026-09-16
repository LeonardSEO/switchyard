# Changelog

Notable changes to Switchyard are documented here.

## 0.3.6 - 2026-09-16

### Fixed

- Use every boundary in the six-level complexity ladder when deciding whether keyword classification is uncertain.
- Preserve the core admission decision in Pi/OMP and expose an explicit notify, escalate, or ignore policy.
- Pass live context size and selected tools from Pi/OMP into core routing, with a callback for operator-supplied risk and cost constraints.
- Prevent sparse or stale outcome history from overriding benchmark priors through sample-aware smoothing and recency weighting.

### Added

- Learn at model, task-kind, complexity, and privacy-safe project scopes, with broader fallback while a specific bucket is sparse.

## 0.3.5 - 2026-09-15

### Fixed

- Keep benchmark priors distinct from measured zero-percent success history.
- Refresh Pi/OMP catalog and Codex-capacity snapshots every ten minutes.
- Learn model quality only from explicit failures and verified outcomes.

### Added

- Add opt-in Pi/OMP routing through `switchyard/auto` with `routingScope: "selected-model"`.
- Add commands to mark the last routed run as verified successful or failed.

## 0.3.4 - 2026-09-15

### Fixed

- Reuse the OpenRouter API credential saved by OpenCode when `OPENROUTER_API_KEY` is not explicitly set.
- Keep an explicit `OPENROUTER_API_KEY` as the highest-priority credential source.

## 0.3.3 - 2026-09-15

### Added

- Add native Oh My Pi plugin discovery alongside the existing Pi extension manifest.
- Document OMP installation and clarify how Switchyard model routing complements OMP's built-in automatic reasoning-effort selection.

## 0.3.2 - 2026-09-14

### Added

- Make Pi task classification codebase-aware with a compact repository profile built from project structure, safe manifest metadata, and Pi-loaded context files.
- Keep classification cache entries isolated per project profile and fall back cleanly when `AGENTS.md`, `CLAUDE.md`, or a known manifest is absent.

## 0.3.1 - 2026-09-14

### Fixed

- Register the OpenCode provider automatically when the plugin loads.
- Close a plugin-owned local gateway when OpenCode disposes the plugin.

### Changed

- Install the OpenCode integration with one `opencode plugin @vepando/switchyard` command; manual provider configuration is no longer required.

## 0.3.0 - 2026-09-14

### Added

- One self-contained `@vepando/switchyard` package for Pi, OpenCode, and the OpenAI-compatible gateway.
- Trusted npm publishing workflow with tag/version validation and provenance.
- Regression coverage for Codex fallback, explain mode, streaming, model matching, run outcomes, and zero-percent success signals.

### Fixed

- Preserve system and developer instructions on supported Codex text requests; keep tools, multimodal messages, and unsupported request controls on the API execution path.
- Reroute to a valid API candidate when Codex execution fails.
- Prevent explain requests from executing a provider.
- Emit valid delta-based chat-completion chunks for subscription streaming.
- Treat a measured zero-percent success rate as evidence instead of falling back to a benchmark.
- Match real Pi Codex model identifiers and avoid recording runs without an assistant response as successful.
- Honor `npm run catalog -- --force` and include repository scripts in type checking.

### Changed

- Internal workspaces are private implementation modules and are no longer published separately.
- GitHub and npm documentation now describe the live model pool, all six routing levels, privacy boundaries, and early-stage limitations.
