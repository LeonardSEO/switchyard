# Contributing to Switchyard

Issues and focused pull requests are welcome. Use the bug or feature issue form
so reports include the affected integration, version, reproduction, and routing
impact. For substantial behavior changes, open an issue first so the routing
contract and compatibility impact can be discussed. Report vulnerabilities
privately through GitHub Security, as described in [SECURITY.md](SECURITY.md).
Contributors whose sustained issues, reviews, tests, or code materially improve
the project may be recognized in [CONTRIBUTORS.md](CONTRIBUTORS.md).

## Local development

Requirements: Node.js 20+ and npm.

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run pack:check
```

Keep changes focused, add tests for observable routing behavior, and do not include credentials or local outcome/cache files. Changes to provider contracts should preserve messages, tools, model identifiers, and streaming semantics unless a breaking change is intentional and documented.

## Pull requests

Explain the user-visible change, its compatibility impact, and the exact validation performed. Do not claim live provider, Codex, or client compatibility unless it was exercised against that system.
