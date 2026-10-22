---
name: qv-release-train
description: Release the packages of a release train (inference, sdk, cli, ai-sdk-provider, the two plugins) together from one branch and one publish run, and open the two documentation cutoff PRs that go with it. Use when releasing the SDK chain, writing a version plan, or invoking /qv-release-train.
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
- Open the two **documentation** PRs right after cutting the train branch, both
  into `main`. They belong to the cutoff, not to the release: nothing in steps 7
  and 8 waits on them, they touch no package, and the release PR and backmerge
  carry no documentation at all. In order:
  1. **6a — close the line being released.** Per documented collection, on a
     branch off `main`, naming that collection's version being released:
     `cd docs/website && bun run scripts/generate-api-docs.ts <version>
     --force-extract`, then `npm run build`. One file per collection
     (`content/docs/<slug>/<current line>/reference/api.mdx`), never
     `src/lib/versions.ts` or `public/_redirects`.
  2. **6b — open the line of the next version.** `qv-docs-line-cut`, on a branch
     off **6a's branch**, never off `main`.
- Never branch 6b off `main`. Branched off `main`, the two merge in order and
  git silently drops 6a from the *preserved* folder — the one production serves —
  conflicting only in the newly opened folder, which no reader has reached yet.
  Stacked on 6a, both merge clean.
- Tell the user which PR is 6a and which is 6b, and that they merge in that
  order. Do not merge either: the documentation engineer reviews them and
  records 6a's merge commit, which is what the production promotion publishes.
- Skipping the two documentation PRs is not an option. A skipped cut leaves the
  coming sprint writing its feature documentation into the folder of a version
  that already shipped. `docs/ci/RELEASE-TRAIN.md` step 6 carries the detail.
- Never approve the `npm` or `pypi` deployment; tell the user when each waits.
- On a failed run, report it. Do not publish a package by hand and do not move
  or delete a tag.
