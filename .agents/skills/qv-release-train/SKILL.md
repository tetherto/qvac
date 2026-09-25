---
name: qv-release-train
description: Release a whole dependency chain in one branch and one publish run. Use when releasing the SDK chain together (inference + sdk + cli + provider + plugins), preparing a release train, writing a version plan, or invoking /qv-release-train.
---

# Release train

Release every package in a train from one branch, in one run: two approvals
instead of seven, one release PR instead of six.

Reference: `docs/ci/RELEASE-TRAIN.md`. Catalog: `.github/release-trains.json`.

## When to use this skill

**Use when:**

- Two or more packages in a train move together, most often a new
  `major.minor` for `@qvac/inference` and `@qvac/sdk` that the agent stack
  has to pick up
- The user asks to release the chain, the pod, or the train
- The user invokes `/qv-release-train`

**Do not use when:**

- One package moves on its own. A CLI patch, an SDK patch that leaves its
  `@qvac/inference` range alone, or an engine patch the existing range already
  satisfies, all stay on the per-package flow in `docs/gitflow.md`. Those
  workflows are unchanged.
- The package is not in a train. `registry-server`, `rag`, `logging`, `error`
  and `test-suite` are SDK-pod-owned but ride no train — check the catalog,
  not the team file.

## Which train

Read `.github/release-trains.json`. Do not carry a package list in your head;
it is the only source, and `nx.json` is generated from it.

```bash
node .github/scripts/release-train-projects.mjs sdk --projects
```

If the packages the user wants are not exactly a train, stop and ask. A train
is a fixed set; releasing a subset is the per-package flow.

## Workflow

### Step 1: Decide the bumps and write the version plan

Ask the user what each package should get if it is not obvious from the work.
Write `.nx/version-plans/<ticket>.md`:

```markdown
---
engine: minor
"@qvac/cli": minor
---

One or two lines on why. This text is not the changelog.
```

Keys are release group names or project names from the catalog. Values are
relative keywords only (`major` / `minor` / `patch` / `pre*`, or `feat!` /
`feat` / `fix`). **An exact version is rejected** — for that, edit the manifest
by hand and skip the plan.

**The trap:** with `updateDependents: "auto"` the cascade stops at the release
group edge. An `engine`-only plan leaves `@qvac/cli` pinned at
`"@qvac/sdk": "^0.20.0"`, which does not match `0.21.0`. If the engine bump is
meant to reach the agent stack, name `@qvac/cli` in the same plan. Check the
dry run below before believing otherwise.

### Step 2: Apply the plan

```bash
pnpm exec nx release version --dry-run
```

Read the output before continuing. Confirm every version and every rewritten
range is what was intended, and that no package outside the train appears.
Then:

```bash
pnpm exec nx release version
```

**Never pass `--groups`, `--projects` or a command-line specifier.** Combined
with a specifier those filters write it into out-of-group projects and
double-bump dependents. The pass is unfiltered by design; group membership is
what confines it.

The command consumes and deletes the plan file, updates `pnpm-lock.yaml`, and
stages its changes.

### Step 3: Changelogs, NOTICE and docs

nx writes no changelog. Run `qv-sdk-changelog` once per package the version
pass moved, engine first:

```
/qv-sdk-changelog --package=inference
/qv-sdk-changelog --package=sdk
/qv-sdk-changelog --package=cli
…
```

`--package=sdk` also regenerates NOTICE, `sdk-python`, and the site docs.
Follow that skill's lockstep rules for the shared display floor.

Do not run `/qv-sdk-inference-version` — the version pass already wrote the
`@qvac/inference` range into `packages/sdk/package.json`.

### Step 4: Cut the branch

```bash
git checkout -b release-train-<train>-<anchor-version> ORG_REMOTE/main
```

`<anchor-version>` is the `anchorGroup`'s version — for the `sdk` train that is
`@qvac/inference` and `@qvac/sdk`'s shared number, not the CLI's.

The branch must match `release-train-<train>-<x.y.z>` exactly.
`release-train-sdk-0.21.0-rc1` and `release-train-0.21.0` both fail the guard.

### Step 5: Open the PRs

One release PR into the train branch, one `[skiplog]` backmerge PR into `main`
(`qv-sdk-backmerge`). Two approvals and a CODEOWNERS review.

Unlike the per-package flow this is **one** pair of PRs for the whole train,
not one pair per package.

### Step 6: Merge, then approve twice

`release-train.yml` runs on the push. It asks for `environment: npm` once for
the whole train, then `environment: pypi` for `tetherto-qvac-sdk`. After that
it tags every package, cuts the SDK's GitHub release and attaches the fat
wheels.

Report both approvals to the user as they come up. Do not approve on their
behalf.

### Step 7: Merge the backmerge PR

As in the per-package flow.

## Recovering a failed train

Re-run the workflow on the same branch. The publish step skips versions
already on npm, and the tag job leaves existing tags alone, so a re-run ships
only what is missing.

`workflow_dispatch` with `publish_pypi_only: true` ships PyPI alone when npm
already succeeded.

Never hand-publish one package out of a train to "catch up" — the next re-run
is the recovery path, and a hand publish skips the provenance the workflow
records.

## Quality checklist

- [ ] The packages being released are exactly a train, per the catalog
- [ ] The version plan names every package that must move, including any whose
      range has to follow across a group boundary
- [ ] `nx release version --dry-run` was read, not skipped
- [ ] No `--groups`, `--projects` or specifier was passed to the version pass
- [ ] A changelog exists for every package whose manifest moved — the branch
      guard fails otherwise
- [ ] The branch is `release-train-<train>-<anchor-version>`, anchor version,
      not the CLI's
- [ ] One release PR and one backmerge PR, not one pair per package
- [ ] `/qv-sdk-inference-version` was **not** run

## References

- Runbook: `docs/ci/RELEASE-TRAIN.md`
- Catalog: `.github/release-trains.json`
- Workflow: `.github/workflows/release-train.yml`
- Branch guard: `.github/scripts/validate-release-train.mjs`
- Per-package flow: `docs/gitflow.md`
- Changelogs: `qv-sdk-changelog` · Backmerge: `qv-sdk-backmerge`
