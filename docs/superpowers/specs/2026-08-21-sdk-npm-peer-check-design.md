# SDK npm Peer-Resolution Check Design

## Context

`SDK Pod Checks` installs `packages/sdk` with Bun before running lint, build,
and tests. Bun and npm resolve peer dependencies differently, so the workflow
can accept a dependency tree that npm consumers reject.

PR #3952 exposed the gap: `@qvac/sdk` selected
`@qvac/translation-nmtcpp@0.10.0`, whose optional
`@qvac/registry-client@^0.4.0` peer conflicted with the SDK's direct
`@qvac/registry-client@^0.6.1` dependency. Bun installed the tree, while a
workspace npm install reported the incompatibility.

The packaged-consumer check did not cover the same topology. Its npm install
could resolve an optional peer below the SDK dependency, and its control flow
also allowed an earlier consumer scenario to fail while a later scenario made
the function return success.

## Goals

- Reject npm-incompatible dependency trees whenever `packages/sdk` is selected
  by the existing SDK pod changed-package detection.
- Treat a non-zero npm exit, `ERESOLVE`, `npm warn peer`, or
  `npm warn peerOptional` as a failed check.
- Preserve the current Bun install and all subsequent SDK checks.
- Make every packaged-consumer scenario contribute to the final result.
- Keep the single required `SDK Pod Checks` job and its existing registry
  configuration.

## Design

Add a workspace npm-install helper inside the existing `Run SDK pod checks`
step. For the `sdk` package, run it once against the committed
`packages/sdk/package.json` before source-specific setup:

1. Run `npm install` with scripts, audit, and funding output disabled while
   teeing stdout and stderr to a temporary log.
2. Record the npm process status explicitly instead of relying on `errexit`.
3. Scan the log explicitly for `ERESOLVE`, `npm warn peer`, and
   `npm warn peerOptional`; any match forces a failed status even if npm exits
   successfully.
4. Remove the temporary log, npm-created `node_modules`, and
   `package-lock.json`.
5. Continue with the existing `bun install`, source setup, lint, typecheck,
   build, and test commands through the workflow's failure accumulator.

Harden `consumer_install_check` by accumulating failures from the default and
lean installs and returning failure when either scenario fails. This avoids
depending on Bash `set -e` behavior when the function itself is called from an
`if` condition.

## Error Handling

The workspace npm helper always returns an explicit status. A failed npm
process and a warning-pattern match are independently sufficient to fail the
check. Cleanup still runs after failure so the Bun checks execute against a
fresh tree and provide complete diagnostics in the same job.

The packaged-consumer helper similarly records each scenario's result and
performs both scenarios before returning the aggregate status.

## Validation

- Run the repository workflow linter on the changed workflow.
- Reproduce the historical optional-peer mismatch in an isolated fixture and
  confirm the npm helper rejects it.
- Run the helper against the current SDK manifest and confirm it succeeds.
- Run the SDK Pod Checks workflow through the PR and wait for all required CI
  checks to finish.

## Non-goals

- Replacing Bun as the SDK package manager.
- Adding or renaming a required status check.
- Changing dependency versions or public SDK behavior.
- Treating unrelated npm warnings as peer-resolution failures.
