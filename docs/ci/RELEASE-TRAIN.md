# Release trains

A release train releases a set of packages that depend on each other, from one
`release-train-<train>-<x.y.z>` branch, behind one npm approval. Every package
in the train moves in every train release, so each release carries the latest
of the whole chain. nx publishes them in dependency order and skips the
dependents of a package that fails.

Today there is one train, `sdk`:

```
@qvac/inference → @qvac/sdk → @qvac/cli → @qvac/ai-sdk-provider → the two plugins
                     └─ tetherto-qvac-sdk on PyPI, at @qvac/sdk's version
```

A single package can still be released on its own (a hotfix) through its
per-package workflow. The next train moves it above that version.

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
- **`.github/release-trains.json`** joins groups into a train:
  - `groups`, and `anchorGroup`: a fixed group whose version names the branch
  - `githubRelease`: the one package that gets a GitHub release; the others get
    a `<slug>-v<version>` tag
  - `checks`: the check jobs in `release-train.yml` that must pass. `sdk` uses
    `shared-runtime-libs`, `sdk-python` and `package-checks`.
  - `packageChecks`: the per-package check config `package-checks` runs
    (`.github/sdk-pod-checks.json`, the same one release PRs use)

## Making a release

1. Bring every range between train packages up to the current workspace
   version (for example the plugins' `@qvac/cli` and `@qvac/ai-sdk-provider`).
   nx only rewrites a range it can see as a workspace link.
2. Write `.nx/version-plans/<ticket>.md` with a bump for every train package.
   Keys are group or project names; values are relative bumps (`major`,
   `minor`, `patch`, `pre*`).

   ```markdown
   ---
   engine: minor
   "@qvac/cli": minor
   "@qvac/ai-sdk-provider": minor
   "@qvac/opencode-plugin": patch
   "@qvac/openclaw-plugin": patch
   ---
   ```

3. Apply it, after reading the dry run, then delete the plan. nx leaves it in
   place and applies every plan on disk on its next run. Do not pass
   `--groups`, `--projects` or a version specifier.

   ```bash
   pnpm exec nx release version --dry-run
   pnpm exec nx release version
   rm .nx/version-plans/<ticket>.md
   ```

4. Write a changelog section for each package (`qv-sdk-changelog`).
5. Cut `release-train-sdk-<engine version>` from `upstream/main`. Open the
   release PR into it from a head not named `release-*`, and the backmerge PR
   into `main`.
6. Merge the release PR. `release-train.yml` then:
   1. checks the branch and lists the packages whose version moved
   2. builds and packs the train, and runs the train's checks
   3. publishes the train to npm after the `npm` approval, as `latest`
   4. waits until npm serves it, and runs each package's checks again against
      npm
   5. publishes `tetherto-qvac-sdk` after the `pypi` approval
   6. tags each package, creates the SDK's GitHub release and attaches the fat
      wheels
7. Merge the backmerge PR.

## Checks

On the release PR (`pr-release-guard.yml`) and on every push
(`release-train.yml`):

- every train package moves, and each anchor package is at the branch version
- every range between train packages accepts the new version of its target
- each moved package has notes under `## [<version>]` in its `CHANGELOG.md`
- no `.nx/version-plans/` file is committed
- on the PR: npm does not have any moved version yet
- on push: a version npm already has was published from this commit (its
  `gitHead`); otherwise the branch has released and the run stops

Before npm publish:

- **`package-checks`**: each package's checks from `.github/sdk-pod-checks.json`
  (install, format, lint, typecheck, build, unit, bare and e2e tests, and the
  SDK's consumer installs), with every train package installed from a tarball
  of this commit and everything else from npm. The release PR runs the same
  through `pr-checks-sdk-pod.yml`.
- **`shared-runtime-libs`**: `check-shared-runtime-libs.mjs` for inference and
  sdk, as `publish-inference.yml` and `publish-sdk.yml` run it.
- **`sdk-python`**: the Python contract check, build, version lockstep and
  `twine check`.
- a workspace package outside the train that the train links must be on npm at
  the linked version.

After npm publish, `package-checks` runs again with every package installed
from npm. Tags, the GitHub release, PyPI and the wheels wait for it.

`workflow_dispatch` with `dry_run: true` runs every check and
`pnpm publish --dry-run`, and publishes, tags and releases nothing.

## Publishing

- Every version is published as `latest`. A version below npm's `latest` stops
  the run; an older line is released through its per-package workflow.
- `gitHead` in each published manifest is the commit it was built from. Each
  tag goes on that commit.
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

The per-package publish workflows for the six train packages run their merge
guard on push and on `workflow_dispatch`, with `strict-slug`: a branch other than
`release-<slug>-x.y.z` fails, so a train branch cannot publish through them.

## Before the first train

npm trusted publishing names a workflow file. Add `release-train.yml` as a
trusted publisher for every package in the train on npm, and for
`tetherto-qvac-sdk` on PyPI. Keep the per-package workflows registered too: npm
allows up to 10 trusted publishers per package, and a hotfix still publishes
through them.
