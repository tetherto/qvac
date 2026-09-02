---
name: qv-sdk-lockstep-sync
description: Stamp the @qvac/inference version onto @qvac/sdk and regenerate tetherto-qvac-sdk so a release-* cut ships one shared version.
---

# SDK Lockstep Client Sync

Keep the SDK pod aligned with the `@qvac/inference` version anchor so a
`release-*` cut ships the same version on npm (`@qvac/inference`, `@qvac/sdk`)
and PyPI (`tetherto-qvac-sdk`).

`@qvac/inference` is the sole version anchor. `sdk` and `sdk-python` follow it
and publish at the same version. The engine drives the number; the SDK is a
transport over it.

## When to use this skill

**Applies to the inference-anchored SDK pod** (not the agent-stack cascade:
cli / ai-sdk-provider / plugins).

**Use when:**

- User runs `/qv-sdk-lockstep-sync` directly.
- Auto-invoked by `/qv-sdk-changelog` when `--package=sdk`.
- Auto-invoked by `/qv-sdk-pr-create` when the PR diff touches the version of
  `packages/inference` or `packages/sdk`.
- Manually, anytime `@qvac/inference`'s `version` changes and you want the pod
  in lockstep before opening a PR.

## Packages

| Package | npm / PyPI | Role |
| --- | --- | --- |
| inference | `@qvac/inference` | Version anchor — the source of truth |
| sdk | `@qvac/sdk` | Follows inference's version |
| sdk-python | `tetherto-qvac-sdk` | Follows via generated client (`SDK_VERSION` stamped from sdk) |

`sdk-python` doesn't get its own changelog — its history lives in
`packages/sdk/CHANGELOG.md`. Commits under `packages/inference` are scanned
into that changelog as well.

## What it does NOT do

- Does not open release PRs or publish (see `publish-sdk.yml` + gitflow).
- Does not sync agent-stack packages (`/qv-agent-stack-sync`).
- Does not auto-commit.
- Does not run in CI. CI enforces the aligned version at release
  (`publish-sdk.yml` verify step); this skill is the fix.

## Workflow

### Step 1: Stamp the inference anchor into sdk

From the monorepo root:

```bash
node .cursor/skills/qv-sdk-lockstep-sync/scripts/sync-sdk-pod.mjs
```

Flags on the script: `--dry-run`, `--check` (exit 1 on drift). It sets
`packages/sdk` `version` to `@qvac/inference`'s version.

### Step 2: Sync `packages/sdk-python` generated client

Requires a venv with gen extras (create once if missing):

```bash
cd packages/sdk-python
python3 -m venv .venv
.venv/bin/pip install -U pip
.venv/bin/pip install -e ".[gen]"
.venv/bin/python3 scripts/generate.py
.venv/bin/python3 scripts/generate.py --check
```

`SDK_VERSION` is stamped from `packages/sdk/package.json` (which Step 1 already
set to the inference anchor). Commit any updates under
`packages/sdk-python/src/tetherto/qvac_sdk/_generated/`.

### Step 3: Review and commit

`git status` should show (as applicable):

- `packages/sdk/package.json`
- `packages/sdk-python/src/tetherto/qvac_sdk/_generated/**`

Commit alongside the originating inference change. When invoked from
`/qv-sdk-changelog`, this is part of the release commit; when invoked from
`/qv-sdk-pr-create`, part of the PR's last commit.

## When this skill is invoked from another skill

### From `/qv-sdk-changelog`

`/qv-sdk-changelog --package=sdk` calls this skill after NOTICE generation for
sdk. Skip for any other `--package` value.

### From `/qv-sdk-pr-create`

If the PR diff touches the `version` of `packages/inference` or
`packages/sdk`, the parent skill prompts to run this skill first. Opt out
with `--no-sync` on the parent skill.

## Quality Checklist

- [ ] `sync-sdk-pod.mjs` reports OK or an apply summary
- [ ] `packages/sdk` version matches `@qvac/inference`
- [ ] `packages/sdk-python` `generate.py --check` passes
- [ ] Staged changes are only lockstep pod artifacts (+ originating inference edit)
- [ ] No CI auto-commits of this skill

## References

- Python generator: `packages/sdk-python/scripts/generate.py`
- Notice generator: `.cursor/skills/qv-notice-generate/SKILL.md`
- Publish: `.github/workflows/publish-sdk.yml`
- Changelog / PR skills: `qv-sdk-changelog`, `qv-sdk-pr-create`
