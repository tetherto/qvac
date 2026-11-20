---
name: qv-merge-guard-wire
description: Make a CI job a required merge check through .github/merge-rules.yml, the rules qvac-merge-guard / validate-pr evaluates
disable-model-invocation: true
---

# Merge Guard Wire: make a job a required merge check

`qvac-merge-guard / validate-pr` passes when every check `.github/merge-rules.yml` requires of a PR has passed. A job blocks merges only once a rule names it. Reference: `docs/ci/MERGE-GUARD.md`.

## Steps

1. **Pick the producer** the job lives in:
   - runs PR code and needs no secrets: `pr-checks.yml`, or `sdk-checks.yml` for the SDK pod;
   - needs secrets or a native build: `pr-build-test.yml`, behind its `trust` gate.

   Add the job there if it does not exist.
2. **Add the check** under the rule for the paths it covers, or a new rule with its own `patterns`:

   ```yaml
   - { workflow: pr-checks.yml, job: "my-check (*)", skipped: pass }
   ```

   `job` is the check-run name: a called workflow's job is `<caller job> / <job name>`, a matrix leg `<name> (<value>)`. Use `skipped: pass` only when the job skips because nothing it covers changed, and make sure the rule also requires the job that selects it, so a failed selection cannot read as a skip.
3. **A new producer workflow**, only if steps 1 and 2 needed one:
   - `pull_request`: no workflow-level `paths` or `paths-ignore`, and add its `name` to `pr-gate-merge.yml`'s `workflow_run.workflows`;
   - `workflow_run`: a `run-name` with the PR head commit, and a last job running `gh workflow run pr-gate-merge.yml -f pr=<n> -f sha=<head>`.
4. **Check:** `node --test .github/scripts/test/ci-trust-policy.test.mjs` fails on a PR workflow that is neither required nor in `ADVISORY_WORKFLOWS`, a workflow the guard does not listen to, a `paths` filter, or a job pattern that matches no job. A PR workflow that should not gate goes in `ADVISORY_WORKFLOWS` with its reason.
5. **Verify after merge:** the rules run from `main`, so open a PR touching the rule's paths and confirm the guard's run summary lists the check; force it to fail once and confirm the status goes red and names it.

## Rules

- Nothing but `pr-gate-merge.yml` posts `qvac-merge-guard / validate-pr`; `ci-trust-policy.test.mjs` enforces it.
- The guard reads job results, never commit statuses, so a new check is a job, not a status.
- Edits to `.github/merge-rules.yml` need a `@tetherto/qvac-internal-merge` review.
