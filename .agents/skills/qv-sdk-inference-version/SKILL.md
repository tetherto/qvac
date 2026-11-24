---
name: qv-sdk-inference-version
description: Point @qvac/sdk at a published @qvac/inference version (shared major.minor) and bring sdk-kotlin's version pin along, so an SDK release ships against an engine that is already on npm.
---

# SDK's @qvac/inference Version

`@qvac/sdk` and `@qvac/inference` expose the same API, so the SDK's own version
and its `@qvac/inference` dependency range share a major and minor. Patch
numbers are free on both sides — `@qvac/sdk` 0.19.4 may depend on
`@qvac/inference` `^0.19.2`.

`packages/sdk-python` (`tetherto-qvac-sdk`) and `packages/sdk-kotlin`
(`qvac-sdk-kotlin-runtime`) are both generated from `@qvac/sdk` at build time
and track the SDK's version. Nothing generated is committed. The Python package
reads its version from `packages/sdk/package.json`; the Kotlin runtime's
`package.json` pins it and needs the bump in Step 3.

## The engine is published first

The SDK's committed range is installed from npm when `publish-npm.yml` builds a
release and by the `published` leg of the SDK's checks in `sdk-checks.yml`, so a
range naming an unpublished version fails both.

Moving to a new major.minor is two releases:

1. `release-inference-<x.y.z>` → `publish-npm.yml` publishes
   `@qvac/inference` and tags `inference-v<x.y.z>`.
2. `release-sdk-<x.y.z>` → this skill points the SDK at that version, then
   `publish-npm.yml` publishes `@qvac/sdk` and `publish-pypi.yml`
   `tetherto-qvac-sdk`.

A patch on either side is one release on its own. An SDK patch leaves its range
alone; an engine patch is picked up by the existing range with no SDK release at
all.

**On a release train** (`qv-release-train`) skip Step 2: `nx release version`
writes the range. Step 3 (`packages/sdk-kotlin`) still applies.

## When to use this skill

**Applies to the SDK pod** (not the agent-stack cascade: cli / ai-sdk-provider /
plugins).

**Use when:**

- User runs `/qv-sdk-inference-version` directly.
- Auto-invoked by `/qv-sdk-changelog` when `--package=sdk`.
- Auto-invoked by `/qv-sdk-pr-create` when the PR diff touches the version of
  `packages/sdk` or its `@qvac/inference` range.
- Manually, when an `@qvac/inference` release has shipped and the SDK should
  depend on it.

## What it does NOT do

- Does not open release PRs or publish (see `publish-npm.yml`,
  `publish-pypi.yml` + gitflow).
- Does not release `@qvac/inference`; it only points the SDK at a version that
  is already published.
- Does not sync agent-stack packages (`/qv-agent-stack-sync`).
- Does not auto-commit.
- Does not run in CI. CI checks the shared major.minor on every PR through the
  SDK's `lint` (`enforce-inference-versions`) and installs the range for real on
  the `published` leg of the SDK's checks in `sdk-checks.yml`; this skill is the fix.

## Workflow

### Step 1: Confirm the engine version is published

```bash
npm view @qvac/inference@<x.y.z> version
```

An empty result means the engine release has not landed. STOP and release
`@qvac/inference` first (`release-inference-<x.y.z>`); everything below writes a
range that cannot resolve until it does.

### Step 2: Point the SDK at that version

From the monorepo root:

```bash
node .agents/skills/qv-sdk-inference-version/scripts/set-inference-version.mjs --engine-version=<x.y.z>
```

Sets `packages/sdk` `version` to `<x.y.0>` and its `@qvac/inference` range to
`^<x.y.z>` (`~` from 1.0.0 onwards, where a caret would reach into the next
minor). For an SDK patch release whose major.minor already matches, add
`--sdk-version=<x.y.z>`.

Other flags: `--dry-run`, `--check` (exit 1 on a mismatch). With no
`--engine-version`, the script only checks the current manifest.

### Step 3: Bring `packages/sdk-kotlin` to the SDK's version

`checkVersionAlignment` requires the Kotlin runtime's `version` and its
`@qvac/sdk` dependency to equal `packages/sdk/package.json`'s version. Set both
in `packages/sdk-kotlin/package.json` to the version Step 2 set. sdk-kotlin's
typecheck in `sdk-checks.yml` runs the alignment check on every PR that reaches
the package, so the release PR and the backmerge both need this edit.

### Step 4: Verify

```bash
cd packages/sdk
npm run enforce-inference-versions
```

This is the same check CI runs inside `lint`.

### Step 5: Review and commit

`git status` should show (as applicable):

- `packages/sdk/package.json`
- `packages/sdk-kotlin/package.json`

Commit alongside the release changelog. When invoked from `/qv-sdk-changelog`,
this is part of the release commit; when invoked from `/qv-sdk-pr-create`, part
of the PR's last commit.

## When this skill is invoked from another skill

### From `/qv-sdk-changelog`

`/qv-sdk-changelog --package=sdk` calls this skill after NOTICE generation for
sdk. Skip for any other `--package` value — an `--package=inference` release
does not touch the SDK.

### From `/qv-sdk-pr-create`

If the PR diff touches the `version` of `packages/sdk` or its `@qvac/inference`
range, the parent skill prompts to run this skill first. Opt out with
`--no-sync` on the parent skill.

## Quality Checklist

- [ ] `@qvac/inference@<x.y.z>` resolves on npm before the range is written
- [ ] `set-inference-version.mjs` reports OK or an apply summary
- [ ] `packages/sdk` version and `@qvac/inference` range share a major.minor
- [ ] Range operator is `^` below 1.0.0, `~` from 1.0.0 onwards
- [ ] `packages/sdk-kotlin` `./gradlew checkVersionAlignment` passes
- [ ] `npm run enforce-inference-versions` passes in `packages/sdk`
- [ ] Staged changes are only the version edits (+ the originating edit)
- [ ] No CI auto-commits of this skill

## References

- Version checks (addon ranges + shared major.minor):
  `packages/sdk/scripts/enforce-inference-versions.ts`
- Kotlin version alignment: `packages/sdk-kotlin/scripts/check-version-alignment.mjs`
- Notice generator: `.agents/skills/qv-notice-generate/SKILL.md`
- Publish: `.github/workflows/publish-npm.yml`,
  `.github/workflows/publish-pypi.yml`
- Changelog / PR skills: `qv-sdk-changelog`, `qv-sdk-pr-create`
