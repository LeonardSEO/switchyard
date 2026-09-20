# Security policy

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability. Use GitHub's **Security** tab and select **Report a vulnerability** to start a private advisory for this repository.

Include the affected version, reproduction steps, expected impact, and any suggested mitigation. Do not include real credentials, customer data, or unrelated private information.

## Supported versions

Security fixes are applied to the latest published version. Switchyard is pre-1.0 software; upgrade to the newest release before reporting an issue that may already have been fixed.

## Scope

Useful reports include credential exposure, unintended prompt or file disclosure, provider-request confusion, authentication bypass, unsafe tool-message handling, and dependency vulnerabilities with a demonstrated path through Switchyard.

## Remote classification

Default model-based classification sends the bounded user objective and, in Pi
and OMP, a compact project profile through OpenRouter to the Jev provider.
Review project instruction files before enabling remote classification. Set
`projectContext: "none"` to omit the project profile, or set
`escalation: "never"` to keep classification local. Switchyard validates Jev responses and
falls back to chat and local classifiers when a response cannot be trusted, but
validation cannot guarantee that a classification is semantically correct.
