# Single fork-ci gate (Option A) — migration plan

Status: **proposed** · Owner: DevOps · Validated in `Olutest/fork-ci-lab`

## Problem

Secret-bearing CI on external fork PRs is gated by the `fork-ci` GitHub
Environment (native required reviewers). Each privileged `pull_request_target`
workflow carries its own gate, so a fork PR that touches several packages pauses
on a **separate approval per workflow**. Measured on live fork PRs (#3510,
#3404): **7 approvals each**, across 7 distinct runs.

All of those approvals encode a single per-commit decision — "is this commit
safe to run with secrets on our runners." Approving 7 times instead of once buys
no additional security; it is pure friction, and it interacts badly with the
"require branches up to date" rule (each branch update re-triggers every gate).

## Goal

A fork PR requires a **flat, small number of approvals regardless of package
count**, with the trust model unchanged:

- native `fork-ci` environment, GitHub-enforced required reviewers,
- `prevent_self_review` intact,
- approval bound to the exact head SHA (a new push re-prompts),
- internal same-repo PRs continue to skip the gate entirely.

Explicitly **not** in scope: the GitHub-App / custom-deployment-protection-rule
approach (Security prefers keeping GitHub as the enforcer), eliminating
`pull_request_target` wholesale (secrets floor), and any change to
`prevent_self_review` or the branch ruleset.

## Design — Option A (two gates, flat)

One new top-level entry workflow owns a **single** fork-ci gate and fans out to
the per-package CI; `pr-gate-merge.yml` keeps its own gate and its distinct
purpose (producing the required `qvac-merge-guard / validate-pr` status).

```
on-pr.yml            (pull_request_target)     <- ONE gate
├─ changes           (paths-filter, all packages)
├─ gate              (environment: fork-ci, fork-only conditional)
├─ pkg-asr-ggml      needs: gate; if changed;  uses: reusable
├─ pkg-llm-llamacpp  needs: gate; if changed;  uses: reusable
└─ … one per package …

pr-gate-merge.yml    (pull_request_target)     <- its OWN gate, unchanged
└─ sanity / prebuilds-caller / sdk-pod-checks / qvac-merge-guard status
```

A fork PR therefore sees **exactly two gates** — `on-pr` and `pr-gate-merge` —
no matter how many packages it touches (was N+1). Internal PRs see none.

Two gates is the floor for Option A: `pr-gate-merge` runs its own privileged
jobs (`prebuilds-caller`) and so needs its own gate. Collapsing to a single gate
would require merging the merge-guard into `on-pr`, which conflates the
"allowed to merge" concern with "authorized to run CI" and edits the
required-status producer — deliberately rejected here.

## Validation (already done)

Proven end-to-end in `Olutest/fork-ci-lab` with a real fork:

| Scenario | Expected | Result |
|---|---|---|
| Fork PR, 2 packages | 2 gates, each fans out from 1 approval | ✅ `on-pr` → pkg-a+pkg-b; `merge-guard` → sanity+status |
| Internal same-repo PR | 0 gates, runs immediately | ✅ 0 pending approvals, all jobs ran |
| New push after approval | re-approval required | ✅ run returned to `waiting` on the new SHA |

## Work items

1. **Add `on-pr.yml`** — `pull_request_target`; jobs: `changes` (paths-filter for
   every package), `gate` (`environment:` fork-only conditional, identical to
   `reusable-fork-approval.yml`), and one `needs: [changes, gate]` +
   `if: contains(fromJSON(needs.changes.outputs.pkgs), '<pkg>')` +
   `uses:` job per package.
2. **Convert the per-package `on-pr-*` (16) to gate-less `workflow_call`
   building blocks** — remove their own `fork-approval` job and
   `pull_request_target` trigger. 12 already declare `workflow_call`; 4 need it
   added (`on-pr-embed-llamacpp`, `on-pr-translation-nmtcpp`, `on-pr-test-sdk`,
   `on-pr-bare-sdk-e2e`), plus the registry pair.
3. **Preserve `ci-router` routing** — the label-selected heavy stages
   (`prebuilds` / `run-cpp-addon-tests` / `run-desktop-addon-tests` /
   `run-mobile-addon-tests` / `run-coload-tests`) must still gate the same jobs,
   whether ci-router stays per-reusable or moves to the parent.
4. **Preserve the `pull_request` split** — no-secret, GitHub-hosted jobs
   (lint/typecheck/JS-unit) stay on `pull_request` (ungated); secret and
   self-hosted jobs stay gated behind `on-pr`. Self-hosted `pull_request`
   consumers keep their `qvac/fork-verified` status check.
5. **Update `ci-trust-policy.test.mjs`** — replace the per-workflow gate
   assertions with: `on-pr.yml` declares exactly one fork-ci gate; every
   converted per-package workflow is `workflow_call`-only and carries **no**
   `fork-approval`/`environment` of its own (a stray gate would silently restore
   the N-gate behaviour); `pr-gate-merge` still carries its gate.
6. **Leave `pr-gate-merge.yml` and `check-approvals.yml` untouched.**

## Required-check safety

The two merge-blocking checks come from always-on workflows, **not** the
per-package ones, so consolidation cannot break merges and the ruleset needs no
change:

- `Check Approvals` ← `check-approvals.yml` (untouched)
- `qvac-merge-guard / validate-pr` ← `pr-gate-merge.yml`, job `qvac-merge-guard`
  → `public-pr.yml` (untouched)

The status-check context is derived from the **job name**, not the workflow
file, so even under Option B (not chosen) the context would be preservable.

## Rollout

1. Land in `qvac-internal` first; verify with a real fork PR (2-gate behaviour,
   internal-skip, re-push re-prompt).
2. Migrate incrementally in `tetherto/qvac`: `on-pr.yml` can own a subset of
   packages first while the remaining `on-pr-*` stay standalone, then cut over —
   so the blast radius per PR is small and reversible.
3. Merge only behind the updated `ci-trust-policy` suite.

## Risks

- **Highest-stakes surface in the repo** (fork trust). Mitigations: scratch-repo
  proof (done), `qvac-internal` dry-run, incremental per-package cutover, and the
  trust-policy tests as the regression net.
- **A converted reusable that keeps its own `environment:` gate** silently
  reintroduces multiple approvals — the new trust-policy test guards this.
- **ci-router routing drift** — heavy stages must map to the same labels; covered
  by the existing coload/label assertions in the trust-policy suite.
