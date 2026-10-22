---
name: qv-release-train
description: Release the packages of a release train (.github/release-trains.json) together from one branch and one publish run. Use when releasing a set of packages that ship as a train, writing a version plan, or invoking /qv-release-train.
---

# Release train

Follow `docs/ci/RELEASE-TRAIN.md`. It holds the procedure, the configuration
and the checks CI runs. `.github/release-trains.json` lists the trains. This
skill adds what an agent does differently.

## When to use

- The user asks to release a train, or invokes `/qv-release-train`.

A hotfix of one train package, and any package outside every train, stays on
the per-package flow in `docs/gitflow.md`.

## Agent rules

- Pick the smallest train that holds every package needing a release, and show
  the user why. For agent-stack packages, run `/qv-agent-stack-sync --plan`
  and show its table; its `Train` column names the train. Every train package
  moves; ask the user for the bump of each when the plan and the work do not
  make it clear.
- Before the version pass, set every range between train packages to the
  current workspace version, then run `pnpm install --lockfile-only`.
- Generate the NOTICE files (the NOTICE step of `qv-sdk-changelog`) before
  the version pass; "Making a release" in `docs/ci/RELEASE-TRAIN.md` says why.
- Show the user the `nx release version --dry-run` output before applying it.
- When the train moves `@qvac/sdk`, skip "Point the SDK at that version" in
  `/qv-sdk-inference-version`: the version pass writes the `@qvac/inference`
  range. Its `sdk-python` and `sdk-kotlin` syncs still apply.
- When the train lists `fromNpm` packages, make the workspace exclusion its own
  commit in the release PR ("Making a release" in `docs/ci/RELEASE-TRAIN.md`),
  and leave it out of the backmerge.
- Open both PRs with `qv-sdk-pr-create`: one release PR, one backmerge, for the
  whole train.
- Never approve the `npm` or `pypi` deployment; tell the user when each waits.
- On a failed run, report it. Do not publish a package by hand and do not move
  or delete a tag.
