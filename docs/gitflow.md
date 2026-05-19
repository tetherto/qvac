# GitFlow for QVAC Public SDKs & Model Packages (Fork-first Monorepo)

This repository uses a **main-first GitFlow** optimized for **public SDK/model packages** inside a monorepo **with a fork-first contribution model**.

## The rules that matter (TL;DR)

- **All development merges into `main`.**
- **All contributor work comes from forks** (no pushing branches in the upstream org repo).
- **Releases are published from versioned `release-<package>-<x.y.z>` branches** that exist in the upstream org repo.
- **Release/patch changes land via fork PRs into `release-*`**, not via upstream branch-to-branch merges.
- **Changes are done as two PRs**: (1) fork → `main` (dev fix), (2) fork → `release-*` (patch release).
- **`feature-*` and `tmp-*` are non-release streams** (GitHub Packages only), used to share dev builds safely.
- CI/CD is **path-scoped** so only the impacted package(s) build/publish.

> **Why this exists:** predictable releases across many packages, fast day-to-day development on `main`, and safe CI/CD in a public repo with forks.

---

## Table of contents

- [Repo conventions](#repo-conventions)
- [Working with forks](#working-with-forks)
- [Branch types](#branch-types-naming-purpose-publishing)
- [Release flow](#release-flow-new-version-xyz)
- [Patch flow](#patch-flow-xyz--xyzz1)
- [Feature & temp flows](#feature--temp-branches-non-release-publishing)
- [Release PR enforcement](#release-pr-enforcement-ci-policy)
- [CI/CD routing requirements](#cicd-routing-requirements-high-level)
- [Quick reference](#quick-reference-one-liners)

---

## Repo conventions

- Packages live under: `packages/<package>/`
- Each package owns its own:
  - `packages/<package>/package.json`
  - `packages/<package>/CHANGELOG.md` (or equivalent changelog file)
- CI workflows are:
  - **Scoped** by `paths: packages/<package>/**`
  - Support a `workdir` input (or env var) pointing at the package folder
- Publishing targets:
  - **GitHub Packages (GPR)** for development streams (`dev`, `feature`, `temp`)
  - **NPM** for release streams (`latest`, optionally `next`/`beta` when explicitly needed)

---

## Working with forks

This repo assumes a **fork-first** workflow:

- **Contributors do not push branches to the upstream org repo** (the “Tether” repo).
- The **upstream org repo is the source of truth** for:
  - `main`
  - all `release-*` branches (NPM publishing lines)
  - any upstream `feature-*` / `tmp-*` branches (when we need a shared dev stream that publishes)
- Contributors create branches in **their fork**, then open PRs **into upstream target branches**.
- Maintainers can create branches within the org if they chose to, while updates to the release branch must come from the fork.

### Roles

- **Maintainers (upstream write access)**:
  - Create upstream `release-*` branches (and optional upstream `feature-*` / `tmp-*` branches when needed)
  - Approve/merge PRs
  - Own CI/CD + publishing permissions
- **Contributors (fork-only by default)**:
  - Create branches in their fork
  - Open PRs into upstream
  - Never merge upstream branches into other upstream branches

### Golden rules

1) **Upstream branches are targets, not workspaces**  
   You don’t “work on” upstream `main`/`release-*`/`feature-*`/`tmp-*` directly. You PR into them from your fork.

2) **No cross-merging inside upstream**  
   No PRs like `main -> release-*` or `release-* -> main` created from upstream branches.  
   If you need commits from `main` in a release line, you **cherry-pick locally in your fork** and PR into the release branch.

3) **Publishing happens on merge to upstream**  
   - Merge to `main` can publish **dev** builds (GitHub Packages) when package paths changed.
   - Merge to `release-*` can publish to **NPM** for that package/version.
   - Merge to `feature-*` / `tmp-*` can publish **feature/temp** builds (GitHub Packages).

### One-time fork setup (recommended)

```bash
# Fork in GitHub UI, then:
git clone https://github.com/<you>/<repo>.git
cd <repo>

git remote add upstream https://github.com/tetherto/<repo>.git

# Sync your local main to upstream main
git fetch upstream
git checkout main
git reset --hard upstream/main
git push origin main --force-with-lease
```

### Daily dev loop (fork → upstream main)

```bash
git fetch upstream
git checkout main
git reset --hard upstream/main

git checkout -b feature-<package>-<short-desc>
# make changes...
git push -u origin feature-<package>-<short-desc>

# Open PR: <your-fork>:feature-...  ->  upstream:main
```

---

## Branch types (naming, purpose, publishing)

| Branch type | Pattern | Created in upstream by | Purpose | Publishes to | Notes |
|---|---|---:|---|---|---|
| Main | `main` | Maintainers | All active development | GitHub Packages (**dev**) | Default integration branch |
| Release | `release-<package>-<x.y.z>` | Maintainers | Versioned release line | **NPM** | Stable releases only |
| Feature | `feature-<package>-*` | Optional (maintainers) | Share a dev build for a large/isolated effort | GitHub Packages (**feature**) | Never publish to NPM |
| Temp | `tmp-<package>-*` | Optional (maintainers) | Experiments / QA previews | GitHub Packages (**temp**) | Never publish to NPM |

**Publishing semantics**

- GitHub Packages dist-tags: `dev`, `feature`, `temp`
- NPM dist-tags: `latest` (stable); optionally `next`/`beta` when explicitly requested

**Dev build versioning (run-id traceability)**

- Development publishes (GitHub Packages) should be **uniquely traceable**.
- CI will append a build identifier (e.g., run id) to the published version *at publish time* (implementation detail of CI), so multiple dev publishes don’t collide.
  - Example shape: `x.y.z-dev.<run_id>` (exact formatting is owned by CI)
- Do **not** commit run-id version bumps to git.

---

![Branch types and publishing](.github/docs/gitflow/images/branch-types-and-publishing.png)

---

## Release flow (new version x.y.z)

![Release flow](.github/docs/gitflow/images/release-flow.png)

### 1) Maintainer creates the upstream release branch from `main`

Release branches are created **in the upstream org repo** and are named per package and version:

```bash
# maintainer action in upstream repo
git checkout main
git pull
git checkout -b release-<package>-<x.y.z>
git push -u origin release-<package>-<x.y.z>
```

> Contributors: do not create `release-*` branches in upstream. You will PR into them from your fork.

### 2) Contributor opens a “Release PR” from their fork into the upstream release branch

PR source: `<your-fork>:<branch>` → target: `upstream:release-<package>-<x.y.z>`

The PR **must** include:
- **Version bump** in `packages/<package>/package.json` → `x.y.z`
- **Changelog update** in `packages/<package>/CHANGELOG.md`

PR naming suggestion:
- `release(<package>): v<x.y.z>`

### 3) Merge the Release PR → CI publishes to NPM

On merge to the upstream `release-*` branch, CI should:
- Build/package the artifact for `packages/<package>`
- Publish to **NPM**
- Create a git tag **and** GitHub release

**Tag format (standard):**
- `<package>-v<x.y.z>`  
  Example: `sdk-v1.0.0`

### 4) Keep `main` aligned with what shipped (fork-based, no upstream cross-merge)

We do **not** merge upstream `release-*` back into upstream `main` directly.

Instead, ensure `main` reflects the shipped version + changelog via one of these patterns:

- **Preferred (planning discipline):** the release branch is cut from a `main` that already contains the intended changelog/version context (often true when release prep happens on `main` first).
- **Otherwise (common):** open a follow-up PR from a fork into upstream `main` that applies the same version/changelog changes.

> Goal: `main` remains the single source of truth for current development state, while release lines are controlled targets for NPM publishing.

---

## Patch flow (x.y.z → x.y.(z+1))

![Patch flow](.github/docs/gitflow/images/patch-flow.png)

### 1) Implement the fix on `main` (fork PR #1)

- Do the work in your fork branch.
- Open PR into upstream `main`.
- Merge into upstream `main`.

This keeps ongoing development correct and ensures the fix exists on the primary development line.

### 2) Maintainer ensures the upstream patch release branch exists

If patching the currently released line, create a new patch branch from the previous release branch:

```bash
# maintainer action in upstream repo
git checkout release-<package>-<x.y.z>
git pull
git checkout -b release-<package>-<x.y.(z+1)>
git push -u origin release-<package>-<x.y.(z+1)>
```

> Contributors: do not branch in upstream; you will PR into `release-<package>-<x.y.(z+1)>` from your fork.

### 3) Cherry-pick the fix commit(s) into your fork branch (fork PR #2)

You will pull the upstream release branch into your local repo, then cherry-pick the fix commit(s) that already landed in upstream `main`.

```bash
git fetch upstream

# create a branch in your fork based on the upstream patch branch
git checkout -b patch-<package>-<x.y.(z+1)> upstream/release-<package>-<x.y.(z+1)>

# cherry-pick the fix commit(s) from upstream main
git cherry-pick <commit_sha_from_upstream_main>

# update required metadata
# - bump packages/<package>/package.json to x.y.(z+1)
# - update packages/<package>/CHANGELOG.md

git push -u origin patch-<package>-<x.y.(z+1)>
```

### 4) Open PR into the upstream patch release branch

PR source: `<your-fork>:patch-...` → target: `upstream:release-<package>-<x.y.(z+1)>`

The PR **must** include:
- Version bump to `x.y.(z+1)`
- Changelog entry describing the patch

### 5) Merge PR → CI publishes patch to NPM

On merge to the upstream patch branch, CI should:
- Publish to NPM
- Tag + GitHub release using `<package>-v<x.y.(z+1)>`

### 6) Keep `main` aligned (already handled)

Because the fix first landed on `main` (PR #1), `main` already contains the functional change.  
Only the release-line version/changelog metadata may require a follow-up PR back to `main` if your process doesn’t prep release metadata on `main` first.

---

## Feature & temp branches (non-release publishing)

![Feature/temp flow](.github/docs/gitflow/images/feature-temp-flow.png)

These branches are used to produce **shareable dev builds** without entering the immediate release train.

### `feature-<package>-*`

Use for a larger change where you need a **development package** to share with others.

**Branch location**
- If we need a persistent shared stream that publishes reliably, a maintainer may create a `feature-*` branch in upstream.
- Contributors PR into that upstream `feature-*` branch from forks.

CI behavior (on merge/push to upstream `feature-*`):
- Build on changes scoped to the package path
- Publish to GitHub Packages with dist-tag `feature`
- Dev version includes a build identifier (run id) for traceability
- **Never publish to NPM**
- Do not create git tags or GitHub releases

### `tmp-<package>-*`

Use for QA previews and experiments.

Branch location + PR rules are the same as feature branches:
- Upstream `tmp-*` exists only when we need upstream workflows/publishing.
- Contributors PR from forks into upstream `tmp-*`.

CI behavior (on merge/push to upstream `tmp-*`):
- Publish to GitHub Packages with dist-tag `temp`
- Dev version includes a build identifier (run id) for traceability
- **Never publish to NPM**
- Do not create git tags or GitHub releases

---

## Release PR enforcement (CI policy)

For **all** `release-*` branches:

✅ Required in PR:
- `packages/<package>/package.json` version **must** increase vs base
- `packages/<package>/CHANGELOG.md` **must** be updated

❌ CI will fail if:
- Version is unchanged / not incremented
- Changelog is missing or unchanged

---

## CI/CD routing requirements (high level)

To reflect branch intent correctly and keep fork PRs safe:

### Event and publishing safety

- **Never publish from PR events.**
  - Publishing requires credentials and must only occur on merge to upstream branches.
- Publish jobs should trigger on:
  - `push` to upstream `main` / `feature-*` / `tmp-*`
  - `push` to upstream `release-*` (or tags created from them)

### Publishing rules

- **NPM publish jobs**
  - Trigger only on `release-*` branches (or tags created from them)
  - Must require version + changelog checks

- **GitHub Packages publish jobs**
  - Trigger on upstream:
    - `main` → dist-tag `dev`
    - `feature-*` → dist-tag `feature`
    - `tmp-*` → dist-tag `temp`

### Path scoping

- All package workflows trigger on:
  - `paths: packages/<package>/**`
- Reusable workflows accept a `workdir` input pointing at the package directory.

---

## Quick reference (one-liners)

### Branch naming

- `main`
- `release-<package>-<x.y.z>`
- `feature-<package>-<anything>`
- `tmp-<package>-<anything>`

### New release (x.y.z)

- Maintainer: create upstream `release-<package>-<x.y.z>` from `main`
- Contributor: fork PR into upstream `release-<package>-<x.y.z>` with:
  - `package.json` bumped to `x.y.z`
  - changelog updated
- Merge → CI publishes to NPM and tags `<package>-v<x.y.z>`

### Patch release (x.y.z → x.y.(z+1))

- PR #1: fork → upstream `main` (the fix)
- Maintainer: create upstream `release-<package>-<x.y.(z+1)>` from previous release branch
- PR #2: cherry-pick fix commit(s) into fork branch → PR into upstream patch branch with:
  - version bump `x.y.(z+1)`
  - changelog updated
- Merge → CI publishes patch to NPM and tags `<package>-v<x.y.(z+1)>`

### Dev sharing (non-NPM)

- Upstream `feature-*` / `tmp-*` exist only when we need a shared publishing stream.
- Contributors PR from forks into those upstream branches.
- CI publishes to GitHub Packages with dist-tags `feature`/`temp` and run-id traceability.

---
