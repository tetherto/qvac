# PR Labels — CI reference

Single source of truth for every label that affects CI behaviour in this repo.

> **Convention** — apply labels via the GitHub PR sidebar. The CI reaction is event-driven and usually visible within ~30s.

---

## External fork authorization — `fork-ci` environment (not a label)

Secret-bearing CI on **external fork PRs** is gated by the GitHub Actions **`fork-ci` environment**, not by a PR label.

| | |
|---|---|
| **Mechanism** | The `fork-approval` job in each privileged `pull_request_target` workflow pauses until a member of `@tetherto/qvac-internal-merge` or `@tetherto/qvac-internal-release` approves the run in the GitHub Actions UI. |
| **Per-commit** | Each new push starts a fresh workflow run that must be re-approved. After approval, the run records a `qvac/fork-verified` commit status on the PR head SHA (used by unprivileged `pull_request` self-hosted jobs such as `pr-test-inference-addon-cpp*`). |
| **Internal PRs** | Same-repo PRs skip the environment gate (empty environment) and run without an approval prompt. |
| **Implementation** | `fork-approval` job calls [`.github/workflows/reusable-fork-approval.yml`](../../.github/workflows/reusable-fork-approval.yml) from each privileged workflow. The `authorize` / `resolve-config` job runs **after** `fork-approval`, checks out `authorize-pr` from the **default branch only**, and `authorize-pr` reads the `qvac/fork-verified` status on the current head SHA as belt-and-suspenders. |
| **Ops verification** | Run `node .github/scripts/verify-fork-ci-environment.mjs` (requires `gh` auth with environments read) to confirm required reviewers are configured on the `fork-ci` environment. |

There is **no self-service path** for external contributors — a merge/release team member must approve the workflow run.

### Ordering matters: approve `fork-ci` **before** applying stage labels

Two different workflow families react to a fork PR, and only one of them waits for you:

- **`pull_request_target`** workflows (`on-pr-*`) contain the `fork-approval` job. They pause on the `fork-ci` environment and resume the moment you approve.
- **`pull_request`** workflows that run on self-hosted runners (`pr-test-inference-addon-cpp*`) never see the environment prompt. Their `authorize` job reads the `qvac/fork-verified` commit status at run time, and that status does not exist until `fork-approval` has been approved.

Writing a commit status is not a `pull_request` event, so approving `fork-ci` does **not** wake up a `pull_request` run that already finished. If you apply `run-cpp-addon-tests` first and approve second, the native tests report skipped and stay skipped — the PR looks green without ever having run them.

Do this instead, in order:

1. Approve the `fork-ci` deployment on the pending `on-pr-*` run and wait for `fork-approval` to go green (this is what writes `qvac/fork-verified` on the head SHA).
2. Then apply the stage label (`run-cpp-addon-tests`, `run-desktop-addon-tests`, …). The `labeled` event starts a fresh `pull_request` run that now finds the status.

If the label was already applied, re-run the `pull_request` workflow instead of toggling the label — `authorize` re-queries the status API on every run.

Each new push invalidates all of this: `qvac/fork-verified` is bound to a single head SHA, so the next commit needs a fresh approval and a fresh label/re-run cycle.

---

## `verified` label — retired for CI gating

The `verified` label is **no longer used to authorize CI**. It may still appear on legacy PRs or docs; do not apply it expecting jobs to start. Use the **`fork-ci` environment approval** on the workflow run instead.

---

## Other CI-relevant labels

| Label | Purpose | Triggered by | Notes |
|---|---|---|---|
| `safe-to-test` | SDK pod security gate — reviewer has audited `packages/sdk/` package + workflow changes from a fork PR. | `pr-checks-sdk-pod.yml`, SDK e2e workflows (`authorize-pr` with `label: safe-to-test`) | Org-wide fork secret access is handled by `fork-ci`; this label remains for SDK-pod-specific checks. |
| `staging` | Deploys the PR to the staging environment for smoke testing. | Staging deploy workflows | Apply when a PR needs out-of-band testing on real infrastructure. |
| `publish` | Triggers a GitHub Packages publish from the PR (pre-release / dev build). | Publish workflows | Use sparingly; consumes a published version slot. |
| `docs-deploy` | Marks docs as ready for production deploy. | Docs deploy workflows | Set when the docs changes are ready to go live alongside PR merge. |
| `tier1`, `tier2` | Approval-bot review-tier groupings. | `approval-check-worker.yml` | The bot uses these to compute whether a PR has met its required approval tier. |
| `test-e2e-smoke` | Runs the smoke E2E suite (currently SDK-only). | E2E test workflows | Faster subset; prefer for PR feedback. |
| `test-e2e-full` | Runs the full E2E suite (currently SDK-only). | E2E workflows | Long-running; use for release branches and major changes. |
| `e2e-tested` | Set automatically by the E2E workflow once a run has completed against the PR. | E2E workflows | Status indicator only; does not pass/fail by itself — see linked run. |
| `NLP` | Marks PRs touching `packages/llm-llamacpp/` or `packages/embed-llamacpp/`. | Routing in approval workflows | Casing matters: it's `NLP`, not `nlp`. |
| `prebuilds`, `run-cpp-addon-tests`, `run-desktop-addon-tests`, `run-mobile-addon-tests`, `run-coload-tests` | Select expensive CI stages on addon PR workflows. | `ci-router` composite in `on-pr-*` workflows | External forks can use these after `fork-ci` approval; internal same-repo PRs skip the fork-ci gate. |

Standard GitHub labels (`bug`, `documentation`, `enhancement`, `good first issue`, `help wanted`, `question`, `wontfix`, `duplicate`, `invalid`) and Dependabot/CodeQL labels (`dependencies`, `javascript`, `github_actions`) are unchanged.

---

## Comment triggers (not labels)

Some commands look like labels but are actually comment triggers handled by `approval-worker.yml`. They do not appear in the GitHub label sidebar.

| Comment | Effect |
|---|---|
| `/review` (or a comment containing `review`) | Asks the approval bot to recompute the PR's approval state and post a status update. |

---

## See also

- [`docs/ci/SELF-HOSTED-RUNNERS.md`](SELF-HOSTED-RUNNERS.md) — Manual Workspace Cleanup, `working-directory: .`, and `runner.environment` on `qvac-*` workflows.
- [`docs/ci/TEAMS.md`](TEAMS.md) — who is in `qvac-internal-dev` / `merge` / `release` / `qvac-external`, and what they can do.
- [`docs/gitflow.md`](../gitflow.md) — branch model and release flow.
