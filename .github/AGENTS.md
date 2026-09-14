# GitHub and CI guidance

Use the active workflows, actions, and validation scripts as the source of truth.
Do not duplicate current matrices, runner labels, workflow counts, action versions,
or required-check configuration in agent instructions.

Read the relevant references before changing CI:

- [`../docs/ci/LABELS.md`](../docs/ci/LABELS.md) for labels and fork trust.
- [`../docs/ci/MERGE-GUARD.md`](../docs/ci/MERGE-GUARD.md) for required-check wiring.
- [`../docs/ci/SELF-HOSTED-RUNNERS.md`](../docs/ci/SELF-HOSTED-RUNNERS.md) for
  persistent runners and workspace cleanup.
- [`../docs/ci/TEAMS.md`](../docs/ci/TEAMS.md) for approval ownership.
- [`../docs/agent-automation.md`](../docs/agent-automation.md) for automation safety.

When editing workflows or composite actions:

- Pin third-party actions to full commit SHAs and retain a readable version comment.
- Declare the least permissions needed. Prefer OIDC to long-lived credentials.
- Treat fork-controlled code and metadata as untrusted, and never expose secrets to
  untrusted pull-request execution.
- Quote shell inputs and pass untrusted values through environment variables rather
  than interpolating them into scripts.
- Preserve the repository's merge-guard architecture when adding a gating job.
- Follow the documented cleanup pattern for persistent self-hosted runners.
- Run the narrowest relevant workflow linter and script tests before handoff.

Rewrite CI documentation in place when behavior changes. Do not append corrective
notes that leave obsolete instructions active.
