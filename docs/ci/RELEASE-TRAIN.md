# Release trains

A release train releases a set of packages that depend on each other, from one
`release-train-<train>-<x.y.z>` branch, behind one npm approval. Every package
in the train moves in every train release, so each release carries the latest
of the whole chain. nx publishes them in dependency order and skips the
dependents of a package that fails.

`.github/release-trains.json` lists the trains.

A single package can still be released on its own (a hotfix) through its
per-package workflow. The next train moves it above that version.

## Configuration

- **`nx.json` `release.groups`** holds the packages. A `fixed` group gives all
  its packages one version; an `independent` group versions each on its own.
  Version settings that differ from the nx default:
  - `versionPlans: true`: bumps come from `.nx/version-plans/`, not commits.
  - `updateDependents: "auto"`: the default (`always`) also bumps dependents
    outside the release groups.
  - `preserveMatchingDependencyRanges: false`: dependents' ranges always move
    to the new version.
  - `adjustSemverBumpsForZeroMajorVersion: false`: a `minor` on `0.x` stays a
    minor.
- **`.github/release-trains.json`** joins groups into a train:
  - `groups`. Two trains may share a group only when one holds every group of
    the other.
  - `anchorGroup`, a fixed group whose version names the branch, or
    `anchorProject`, one package whose version does
  - `fromNpm`: directories of workspace packages the train depends on but
    builds and checks against the version on npm (see
    [Making a release](#making-a-release))
  - `githubRelease`: the one package that gets a GitHub release; the others get
    a `<slug>-v<version>` tag
  - `checks`: the check jobs in `release-train.yml` that must pass
  - `packageChecks`: the per-package check config `package-checks` runs

## Making a release

1. Bring every range between train packages up to the current workspace
   version (for example the plugins' `@qvac/cli` and `@qvac/ai-sdk-provider`).
   nx only rewrites a range it can see as a workspace link.
2. Regenerate each package's NOTICE. The generator runs `npm install` in the
   package directory, which fails once the version pass has moved a train
   dependency to a version npm does not have yet. It also replaces the
   package's `node_modules`; run `pnpm install --frozen-lockfile` afterwards.
3. Write `.nx/version-plans/<ticket>.md` with a bump for every train package.
   Keys are group or project names; values are relative bumps (`major`,
   `minor`, `patch`, `pre*`). nx requires a message after the frontmatter.

   ```markdown
   ---
   <fixed group>: minor
   "<package of an independent group>": patch
   ---

   Release the <train> train.
   ```

4. Apply it, after reading the dry run, then delete the plan. nx leaves it in
   place and applies every plan on disk on its next run. Do not pass
   `--groups`, `--projects` or a version specifier.

   ```bash
   pnpm exec nx release version --dry-run
   pnpm exec nx release version
   rm .nx/version-plans/<ticket>.md
   ```

5. Write a changelog section for each package (`qv-sdk-changelog`). When the
   train moves `@qvac/sdk`, bring `packages/sdk-python` and
   `packages/sdk-kotlin` to its new version (the `sdk-python` and `sdk-kotlin`
   syncs of `qv-sdk-inference-version`); `pr-checks-sdk-kotlin.yml` checks the Kotlin
   version on both PRs.

   When the train lists `fromNpm` packages, take them out of the workspace in a
   separate commit. pnpm links a workspace package whenever its version
   satisfies the range, so the train would otherwise build against the
   workspace copy instead of the version on npm:

   ```bash
   node .github/scripts/release-train.mjs exclude <train>
   pnpm install --lockfile-only
   git add pnpm-workspace.yaml pnpm-lock.yaml
   ```

6. Cut `release-train-<train>-<anchor version>` from `upstream/main`. Open the
   release PR into it from a head not named `release-*`, and the backmerge PR
   into `main` from `backmerge/release-train-<train>-<anchor version>`. The
   backmerge keeps `main`'s `pnpm-workspace.yaml` and regenerates
   `pnpm-lock.yaml` from it.
7. Wait for the release PR's `Release Train (nx)` run, the dry run described
   under [Checks](#checks), then merge the release PR. `release-train.yml`
   then:
   1. checks the branch and lists the packages whose version moved
   2. builds and packs the train, and runs the train's checks
   3. publishes the train to npm after the `npm` approval, as `latest`
   4. waits until npm serves it, and runs each package's checks again against
      npm
   5. with the `sdk-python` check, publishes `tetherto-qvac-sdk` after the
      `pypi` approval
   6. tags each package, creates the `githubRelease` package's GitHub release
      and, with `sdk-python`, attaches the fat wheels
8. Merge the backmerge PR once the push run has published to npm. Before that,
   `main` would name versions that the checks of later PRs cannot install. If
   the run fails before publishing, fix it with a PR into the train branch
   (see [Recovery](#recovery)) and carry the same commit to the backmerge.

## Checks

On the release PR (`pr-release-guard.yml` and `release-train.yml`) and on every
push (`release-train.yml`):

- every train package moves, and each anchor package is at the branch version
- every range between train packages accepts the new version of its target
- each moved package has notes under `## [<version>]` in its `CHANGELOG.md`
- no `.nx/version-plans/` file is committed
- every `fromNpm` directory is left out of `pnpm-workspace.yaml`, and is not a
  train package
- on the PR: npm does not have any moved version yet
- on push: a version npm already has was published from this commit (its
  `gitHead`); otherwise the branch has released and the run stops

Before npm publish:

- **`package-checks`**: each package's checks from the train's `packageChecks`
  config (install, format, lint, typecheck, build, unit, bare and e2e tests,
  and the SDK's consumer installs), with every train package installed from a tarball
  of this commit and everything else from npm. The backmerge PR, from
  `backmerge/release-train-<train>-<x.y.z>` into `main`, runs the same through
  `pr-checks-sdk-pod.yml`, except for a train with `fromNpm` packages, whose
  backmerge installs every package from npm.
- **`shared-runtime-libs`**: `check-shared-runtime-libs.mjs` for inference and
  sdk, as `publish-inference.yml` and `publish-sdk.yml` run it.
- **`sdk-python`**: the Python contract check, build, version lockstep and
  `twine check`.
- a workspace package outside the train that the train links must be on npm at
  the linked version.

After npm publish, `package-checks` runs again with every package installed
from npm. Tags, the GitHub release, PyPI and the wheels wait for it.

### Dry run

Every PR into a train branch runs `release-train.yml` as a dry run: the checks
above, the build, and `pnpm publish --dry-run`, which also stops on a version
below npm's `latest`. The run measures the train from the merge base with
`main`, so a fix PR after the release PR checks the whole train again. A
`workflow_dispatch` with `dry_run: true` on the train branch does the
same. A dry run publishes, tags and releases nothing, and needs no approval:
`pnpm publish --dry-run` runs in its own job, with no environment and no
`id-token`. Publishing runs only on a push or a dispatch without `dry_run`, in
the job that holds the `npm` environment. Both jobs wait for `checks-passed`,
which requires the build and every check the train lists.

## Publishing

- Every version is published as `latest`. A version below npm's `latest` stops
  the run; an older line is released through its per-package workflow.
- `gitHead` in each published manifest is the commit it was built from. Each
  tag goes on that commit, the GitHub release's tag included.
- npm's sha of each published tarball must match the tarball the build job
  packed.
- A version npm already has is skipped.

## Recovery

- **Nothing published yet** (a check failed, or the approval was rejected): fix
  it with a PR into the same branch.
- **Partly published, transient error**: re-run the workflow on the same
  commit. Versions on npm from that commit are skipped.
- **Partly published, fix needs a new commit**: the branch can no longer
  publish. Cut a new train with new versions for the packages npm already has;
  the others can keep theirs.
- `workflow_dispatch` with `publish_pypi_only: true` publishes PyPI alone.

## Per-package workflows

The per-package publish workflows of train packages run their merge
guard on push and on `workflow_dispatch`, with `strict-slug`: a branch other than
`release-<slug>-x.y.z` fails, so a train branch cannot publish through them.

## Before a train's first release

npm trusted publishing names a workflow file. Add `release-train.yml` as a
trusted publisher for every package in the train on npm, with environment
`npm`, and, for a train with the `sdk-python` check, for `tetherto-qvac-sdk` on
PyPI, with environment `pypi`. A release
PR runs its own copy of `release-train.yml`; binding the publisher to the
environment means only a job that passed that environment's approval gets a
token npm or PyPI accepts. Keep the per-package workflows registered too: npm
allows up to 10 trusted publishers per package, and a hotfix still publishes
through them.

The `release` ruleset matches `release-train-*` but requires only `Check
Approvals`. A ruleset on `refs/heads/release-train-*` that requires `Train
checks passed` keeps a release PR with a failed dry run from merging. It
cannot go into the `release` ruleset: per-package release PRs never report
that check.
