# SDK Lockstep Client Sync

Keep the SDK pod aligned with the `@qvac/inference` version anchor so a
`release-*` cut ships the same version on npm (`@qvac/inference`, `@qvac/sdk`,
`@qvac/bare-sdk`) and PyPI (`tetherto-qvac-sdk`).

`@qvac/inference` is the sole version anchor. `sdk`, `bare-sdk` and `sdk-python`
follow it and publish at the same version. The engine drives the number; the SDK
and its bare assembly are transports over it. `bare-sdk` additionally mirrors
`sdk`'s runtime dependency ranges (minus addon plugins) — the dep-parity gate
(`check:deps-vs-sdk`) still applies.

## When to use this skill

**Applies to the inference-anchored SDK pod** (not the agent-stack cascade:
cli / ai-sdk-provider / plugins).

**Use when:**

- User runs `/qv-sdk-lockstep-sync` directly.
- Auto-invoked by `/qv-sdk-changelog` when `--package=sdk`.
- Auto-invoked by `/qv-sdk-pr-create` when the PR diff touches the version of
  `packages/inference`, `packages/sdk` or `packages/bare-sdk`.
- Manually, anytime `@qvac/inference`'s `version` changes and you want the pod
  in lockstep before opening a PR.

## Packages

| Package | npm / PyPI | Role |
| --- | --- | --- |
| inference | `@qvac/inference` | Version anchor — the source of truth |
| sdk | `@qvac/sdk` | Follows inference's version |
| bare-sdk | `@qvac/bare-sdk` | Follows inference's version; mirrors sdk's runtime dep ranges (dep parity via `check:deps-vs-sdk`) |
| sdk-python | `tetherto-qvac-sdk` | Follows via generated client (`SDK_VERSION` stamped from sdk) |

`bare-sdk` and `sdk-python` don't get their own changelog — their history lives
in `packages/sdk/CHANGELOG.md`. The anchor, `@qvac/inference`, maintains its own
`packages/inference/CHANGELOG.md` by hand (edited per release).

## What it does NOT do

- Does not open release PRs or publish (see `publish-sdk.yml` +
  `trigger-reusable-lib-inference.yml` + gitflow).
- Does not sync agent-stack packages (`/qv-agent-stack-sync`).
- Does not auto-commit.
- Does not run in CI. CI enforces the aligned version at release
  (`publish-sdk.yml` verify step); this skill is the fix.

## Workflow

### Step 1: Stamp the inference anchor into sdk + bare-sdk

From the monorepo root:

```bash
node .cursor/skills/qv-sdk-lockstep-sync/scripts/sync-sdk-pod.mjs
```

Flags on the script: `--dry-run`, `--check` (exit 1 on drift). It sets
`packages/sdk` and `packages/bare-sdk` `version` to `@qvac/inference`'s version,
and mirrors sdk's shared dependency ranges into bare-sdk (minus addon plugins).

Then confirm bare-sdk dep parity holds:

```bash
cd packages/bare-sdk
bun run check:deps-vs-sdk
```

NOTICE regeneration is a **separate** step (needs env tokens):

```bash
source .env
node .cursor/skills/qv-notice-generate/scripts/generate-notice.js bare-sdk
```

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
- `packages/bare-sdk/package.json`
- `packages/bare-sdk/NOTICE`
- `packages/sdk-python/src/tetherto/qvac_sdk/_generated/**`

Commit alongside the originating inference change. When invoked from
`/qv-sdk-changelog`, this is part of the release commit; when invoked from
`/qv-sdk-pr-create`, part of the PR's last commit.

## When this skill is invoked from another skill

### From `/qv-sdk-changelog`

`/qv-sdk-changelog --package=sdk` calls this skill after NOTICE generation for
sdk. Skip for any other `--package` value.

### From `/qv-sdk-pr-create`

If the PR diff touches the `version` of `packages/inference`, `packages/sdk` or
`packages/bare-sdk`, the parent skill prompts to run this skill first. Opt out
with `--no-sync` on the parent skill.

## Quality Checklist

- [ ] `sync-sdk-pod.mjs` reports OK or an apply summary; `check:deps-vs-sdk` passes
- [ ] `packages/sdk` and `packages/bare-sdk` versions match `@qvac/inference`
- [ ] `packages/bare-sdk/NOTICE` regenerated when bare-sdk deps/version changed
- [ ] `packages/sdk-python` `generate.py --check` passes
- [ ] Staged changes are only lockstep pod artifacts (+ originating inference edit)
- [ ] No CI auto-commits of this skill

## References

- bare-sdk drift check: `packages/bare-sdk/scripts/check-deps-vs-sdk.mjs`
- Python generator: `packages/sdk-python/scripts/generate.py`
- Notice generator: `.cursor/skills/qv-notice-generate/SKILL.md`
- Publish: `.github/workflows/publish-sdk.yml` (npm + PyPI),
  `.github/workflows/trigger-reusable-lib-inference.yml` (inference)
- Changelog / PR skills: `qv-sdk-changelog`, `qv-sdk-pr-create`
