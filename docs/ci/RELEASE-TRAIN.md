# Release trains

A **release train** is a set of packages that release together because they
depend on each other in a line. One branch, one PR, one publish run, two
approvals.

A train is not a team's package roster. The SDK pod
(`.github/teams/sdk.json`) also owns `registry-server`, `rag`, `logging`,
`error` and `test-suite`; those release on their own and are in no train.

Today there is one train, `sdk`:

```
@qvac/inference → @qvac/sdk → @qvac/cli → @qvac/ai-sdk-provider → the two plugins
                     └─ tetherto-qvac-sdk (PyPI sidecar, same version as @qvac/sdk)
```

The per-package release workflows are unchanged and still own a
single-package release. A CLI patch does not have to ride the train.

## The catalog

`.github/release-trains.json` is the only place a train's contents live.
`nx.json`'s `release` block is generated from it:

```bash
node .github/scripts/sync-release-trains.mjs     # regenerate nx.json
node .github/scripts/validate-release-trains.mjs # fail on drift
```

`release-train.yml` runs the validator before it builds anything, so a stale
`nx.json` stops the release rather than publishing versions nx would have
computed differently.

| Catalog field | What it decides |
|---|---|
| `groups` | The nx release groups. `fixed` releases its members in lockstep; `independent` lets each move on its own version. |
| `anchorGroup` | Which group's version the branch name carries. Must be `fixed`. |
| `projects[].postPublish` | `tag: true` for a plain `<slug>-v<version>` tag, or `githubRelease` for a release (which carries its own tag). |
| `projects[].postPublish.assets` | Assets attached to that release, declared in the top-level `assets` block. |
| `sidecars` | Packages released alongside on another registry — today `tetherto-qvac-sdk` on PyPI. |

Adding a package to a train, or adding a train, is an edit to the catalog plus
`sync-release-trains.mjs`. Adding a new *asset* also needs a job in
`release-train.yml`, because `uses:` must be a literal; the validator says so
rather than failing at runtime.

## Making a release

### 1. Write a version plan

The train derives no version on its own. Declare the bumps in a markdown file
under `.nx/version-plans/`:

```markdown
---
engine: minor
"@qvac/cli": minor
---

Engine gets the streaming tokenizer. CLI exposes the new flag.
```

Keys are release group names or project names. Values are relative keywords
only — `major`, `minor`, `patch`, `premajor`, `preminor`, `prepatch`,
`prerelease`, plus the conventional aliases `feat!`, `feat`, `fix`. An exact
version is rejected.

**The cascade stops at the release group edge.** An `engine`-only plan leaves
`@qvac/cli` pinned at `"@qvac/sdk": "^0.20.0"`, which does not match `0.21.0`.
If an engine bump is meant to reach the agent stack, name `@qvac/cli` in the
same plan.

For an exact version, edit the manifest by hand and skip the plan; publishing
reads the version off disk.

### 2. Apply it

```bash
pnpm exec nx release version --dry-run   # read the versions and ranges first
pnpm exec nx release version
```

This writes every version, rewrites every dependency range, updates
`pnpm-lock.yaml`, and deletes the plan file it consumed. Never pass `--groups`,
`--projects` or a command-line specifier: combined with a specifier those
filters write it into out-of-group projects. The pass is meant to be
unfiltered.

### 3. Changelogs, NOTICE, docs

Per package, as today — nx writes none:

```bash
/qv-sdk-changelog --package=inference
/qv-sdk-changelog --package=sdk        # also NOTICE, sdk-python, site docs
/qv-sdk-changelog --package=cli
# …one per package the version pass moved
```

### 4. Cut the branch and open the PR

```bash
git checkout -b release-train-sdk-<engine-version> upstream/main
```

The version is the `anchorGroup`'s — `engine`, so `@qvac/inference` and
`@qvac/sdk`'s shared number. The agent stack moves on its own versions
underneath it.

One release PR into that branch, one `[skiplog]` backmerge PR into `main`.
Two approvals and a CODEOWNERS review, as for any release branch.

### 5. Merge

`release-train.yml` then:

1. resolves the train from the branch and checks `nx.json` against the catalog
2. runs the branch guard — anchor packages at the branch version, the anchor
   group sharing a major and minor, a changelog from every package whose
   manifest moved
3. builds every package from the pnpm workspace, so nothing waits on npm
4. **approval 1** — `environment: npm` — `release-train-publish.mjs` publishes
   one package at a time in dependency order and stops at the first failure.
   Each package gets `latest`, or `release-<major>.<minor>` when it is older
   than npm's `latest` or a prerelease, unless `npm_tag` is given
5. **approval 2** — `environment: pypi` — `tetherto-qvac-sdk`
6. tags each package, cuts the SDK's GitHub release, attaches the fat wheels

### 6. Merge the backmerge PR

As today.

## Recovering a half-shipped train

Re-run the workflow on the same branch. Every step is idempotent:

- the publish step skips a version already on npm and publishes the rest
- the tag job leaves an existing tag alone and never moves it
- `create-github-release` and the fat-wheel build are unchanged from the
  single-package path

`workflow_dispatch` with `publish_pypi_only: true` ships PyPI alone when npm
already succeeded.

## Before the first real release

Trusted publishing binds a publisher to a repository **and a workflow
filename**. Every package in the train is registered against its current
publish workflow, so a publish from `release-train.yml` is refused until that
workflow is registered too. This is the same failure that cost
`@qvac/inference` 0.20.0 a day: run `35591582684` was approved and then failed
with `npm error 404 Not Found - PUT https://registry.npmjs.org/@qvac%2finference`
because the package had only ever been published by `publish-sdk.yml`.

See the checklist in the pull request that introduced this document.
