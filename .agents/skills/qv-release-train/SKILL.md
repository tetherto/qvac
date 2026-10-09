---
name: qv-release-train
description: Release the packages of a release train (inference, sdk, cli, ai-sdk-provider, the two plugins) together from one branch and one publish run. Use when releasing the SDK chain, writing a version plan, or invoking /qv-release-train.
---

# Release train

Follow `docs/ci/RELEASE-TRAIN.md`. It holds the procedure, the configuration
and the checks CI runs. This skill adds what an agent does differently.

## When to use

- The user asks to release the SDK chain or the train, or invokes
  `/qv-release-train`.

A hotfix of one train package, and any package outside every train
(`registry-server`, `rag`, `logging`, `error`, `test-suite`), stays on the
per-package flow in `docs/gitflow.md`.

## Agent rules

- Every train package moves. Ask the user for the bump of each when the work
  does not make it clear.
- Before the version pass, set every range between train packages to the
  current workspace version, then run `pnpm install --lockfile-only`.
- Show the user the `nx release version --dry-run` output before applying it.
- Do not run `/qv-sdk-inference-version`: the version pass writes the
  `@qvac/inference` range. Regenerate `packages/sdk-python` per
  `qv-sdk-changelog` when `@qvac/sdk` moves.
- Open both PRs with `qv-sdk-pr-create`: one release PR, one backmerge, for the
  whole train.
- Never approve the `npm` or `pypi` deployment; tell the user when each waits.
- On a failed run, report it. Do not publish a package by hand and do not move
  or delete a tag.
