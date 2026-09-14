# Changelog

Notable changes to Switchyard are documented here.

## 0.3.0 - unreleased

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
