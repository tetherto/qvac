# Release trains

A release train publishes a set of packages that depend on each other, from one
`release-train-<train>-<x.y.z>` branch, behind one npm approval. nx publishes
them in dependency order and skips the dependents of a package that fails.

Today there is one train, `sdk`:

```
@qvac/inference → @qvac/sdk → @qvac/cli → @qvac/ai-sdk-provider → the two plugins
                     └─ tetherto-qvac-sdk on PyPI, at @qvac/sdk's version
```

## Configuration

- **`nx.json` `release.groups`** holds the packages. `engine` (`@qvac/inference`,
  `@qvac/sdk`) is `fixed`: one version for both. `agentstack` (cli, provider,
  plugins) is `independent`. Version settings that differ from the nx default:
  - `versionPlans: true`: bumps come from `.nx/version-plans/`, not commits.
  - `updateDependents: "auto"`: the default (`always`) also bumps dependents
    outside the release groups.
  - `preserveMatchingDependencyRanges: false`: dependents' ranges always move
    to the new version.
  - `adjustSemverBumpsForZeroMajorVersion: false`: a `minor` on `0.x` stays a
    minor.
- **`.github/release-trains.json`** joins groups into a train: `groups`,
  `anchorGroup` (a fixed group whose version names the branch) and
  `githubRelease` (the one package that gets a GitHub release; the others get a
  `<slug>-v<version>` tag).

## What a release must contain

Every train package that nx counts as affected since the last train release
moves in the next one. The last train release is the anchor's tag:
`inference-v<version on main>`.

```bash
pnpm exec nx show projects --affected --base=inference-v<version> --head=upstream/main
```

The train packages in that list go in the version plan. nx counts a change to a
dependency, and to workspace files such as `nx.json`, as affecting every
dependent.

## Making a release

1. Write `.nx/version-plans/<ticket>.md`. Keys are group or project names;
   values are relative bumps (`major`, `minor`, `patch`, `pre*`). For an exact
   version, edit the manifest instead.

   ```markdown
   ---
   engine: minor
   "@qvac/cli": minor
   "@qvac/ai-sdk-provider": minor
   ---
   ```

2. Apply it, after reading the dry run:

   ```bash
   pnpm exec nx release version --dry-run
   pnpm exec nx release version
   ```

   This writes versions, dependency ranges and `pnpm-lock.yaml`. nx leaves the
   plan file in place and applies every plan on disk on its next run, so delete
   it now. `.nx/` is git-ignored, and the checks fail a commit that tracks a
   plan. Do not pass `--groups`, `--projects` or a version specifier.

   ```bash
   rm .nx/version-plans/<ticket>.md
   ```

3. Write a changelog section for each package that moved (`qv-sdk-changelog`).
4. Cut `release-train-sdk-<engine version>` from `upstream/main`. Open the
   release PR into it from a head not named `release-*`, and the backmerge PR
   into `main`.
5. Merge the release PR. `release-train.yml` then:
   1. checks the branch and lists the packages whose version moved
   2. builds the train from the pnpm workspace
   3. publishes the moved packages to npm after the `npm` approval
   4. publishes `tetherto-qvac-sdk` after the `pypi` approval
   5. tags each package, creates the SDK's GitHub release and attaches the fat
      wheels
6. Merge the backmerge PR.

## Checks

`pr-release-guard.yml` runs these on the release PR, and `release-train.yml` on
every push:

- each `anchorGroup` package is at the branch version
- each moved package has notes under `## [<version>]` in its `CHANGELOG.md`
- each train package nx counts as affected since the last train release moves
- no `.nx/version-plans/` file is committed
- on the PR only: npm does not have any moved version yet

Before npm publish, the workflow also fails when:

- the train links a workspace package from outside the train at a version npm
  does not have
- installing `@qvac/inference` or `@qvac/sdk` resolves a shared runtime library
  to more than one version (`check-shared-runtime-libs.mjs`, as in
  `publish-inference.yml` and `publish-sdk.yml`)

`workflow_dispatch` with `dry_run: true` runs every check and
`pnpm publish --dry-run`, and publishes, tags and releases nothing.

## Recovery

Re-run the workflow. Versions already on npm are skipped, a tag already on this
commit is left alone, and a tag on another commit fails the job.
`workflow_dispatch` with `publish_pypi_only: true` publishes PyPI alone.

One run publishes every package under one dist-tag: `latest`, or
`release-<major>.<minor>` for a version below npm's `latest`. When the moved
packages need different dist-tags the run stops; pass `npm_tag`.

## Before the first train

npm trusted publishing names a workflow file. Add `release-train.yml` as a
trusted publisher for every package in the train on npm, and for
`tetherto-qvac-sdk` on PyPI. Keep the per-package workflows registered too: npm
allows up to 10 trusted publishers per package, and a single-package release
still publishes through them.
