# PR Labels — CI reference

Single source of truth for every label that affects CI behaviour in this repo.

> **Convention** — apply labels via the GitHub PR sidebar. The CI reaction is event-driven and usually visible within ~30s.

---

## `verified` — secret-bearing CI authorisation

This is the label that gates every secret-bearing PR job in the repo.

| | |
|---|---|
| **Purpose** | Authorise the `label-gate` composite action so that secret-bearing jobs (sanity-checks, prebuilds, publish, deploy, etc.) are allowed to run on a PR. |
| **Who can apply** | Active member of `@tetherto/qvac-internal-dev`, `@tetherto/qvac-internal-merge`, or `@tetherto/qvac-internal-release`. See [TEAMS.md](TEAMS.md). |
| **What it gates** | Every secret-bearing workflow under `.github/workflows/` (108 workflows as of QVAC-18612). Specifically, every job downstream of `needs: [..., label-gate]` whose `if:` includes `needs.label-gate.outputs.authorised == 'true'`. |
| **Behaviour on `synchronize`** | When a non-trusted actor pushes new commits to a verified PR, `label-gate` strips the label automatically. A trusted actor must re-apply it after reviewing the new commits. This prevents authorisation from silently inheriting across content changes by an untrusted contributor. |
| **Behaviour on apply by non-trusted actor** | The label is stripped immediately and the gate denies. This avoids a "look, it's verified" social signal that doesn't actually mean the PR is authorised. |
| **Approval bot tier** | Recognised as **tier 1** by `approval-check-worker`. |
| **Implementation** | [`.github/actions/label-gate/README.md`](../../.github/actions/label-gate/README.md) — full trust model, exit policy, and test coverage. |

### When CI is blocked by `label-gate`

If your PR's secret-bearing jobs are skipping with a `label-gate.outputs.authorised != 'true'` condition, ask any member of the three teams above to apply `verified`. There is intentionally no self-service path — the whole point of the gate is that someone other than the PR author signs off.

---

## No `release` label — npm publish authorisation lives in the `npm` environment

There is **intentionally no `release` (or similar) label** for authorising npm publishes. Publish authorisation is a single reviewer click on the dedicated `npm` GitHub Actions environment, scoped only to the `publish-*` jobs that consume `NPM_TOKEN` / OIDC. This keeps the publish gate visible in the GitHub Actions UI rather than buried in a label state, and it pairs with each package's npm Trusted Publisher configuration.

The legacy `release` environment is kept for backwards-compatibility while the `verified` flow rolls out; its reviewer requirement will be removed once the `npm` environment owns the publish gate end-to-end.

---

## Other CI-relevant labels

The following labels are recognised by CI workflows but are not part of the `label-gate` flow.

| Label | Purpose | Triggered by | Notes |
|---|---|---|---|
| `verified` (see `verify` deprecation note) | Canonical authorisation label — see the [`verified` section above](#verified--secret-bearing-ci-authorisation) for the full trust model. | `label-gate` composite action (108 secret-bearing workflows) | `verify` is a **deprecated** legacy alias for the same intent, still recognised by `public-reusable-npm.yml`, `pr-test-inference-addon-cpp*.yml`, and `pr-models-validation-registry-server.yml` pending migration to `verified`. Do not document `verify` as a recommended action in new tooling. |
| `safe-to-test` | SDK pod security gate — reviewer has audited `packages/sdk/` package + workflow changes from a fork PR. | `pr-checks-sdk-pod.yml` | Org-wide secret authorisation is now handled by `verified`; `safe-to-test` remains in use for SDK pod check-running. |
| `staging` | Deploys the PR to the staging environment for smoke testing. | Staging deploy workflows | Apply when a PR needs out-of-band testing on real infrastructure. |
| `publish` | Triggers a GitHub Packages publish from the PR (pre-release / dev build). | Publish workflows | Use sparingly; consumes a published version slot. |
| `docs-deploy` | Marks docs as ready for production deploy. | Docs deploy workflows | Set when the docs changes are ready to go live alongside PR merge. |
| `tier1`, `tier2` | Approval-bot review-tier groupings. | `approval-check-worker.yml` | The bot uses these to compute whether a PR has met its required approval tier. `verified` counts as tier 1. |
| `test-e2e-smoke` | Runs the smoke E2E suite (currently SDK-only). | E2E test workflows | Faster subset; prefer for PR feedback. |
| `test-e2e-full` | Runs the full E2E suite (currently SDK-only). | E2E test workflows | Long-running; use for release branches and major changes. |
| `e2e-tested` | Set automatically by the E2E workflow once a run has completed against the PR. | E2E workflows | Status indicator only; does not pass/fail by itself — see linked run. |
| `NLP` | Marks PRs touching `packages/llm-llamacpp/` or `packages/embed-llamacpp/`. | Routing in approval workflows | Casing matters: it's `NLP`, not `nlp`. |

Standard GitHub labels (`bug`, `documentation`, `enhancement`, `good first issue`, `help wanted`, `question`, `wontfix`, `duplicate`, `invalid`) and Dependabot/CodeQL labels (`dependencies`, `javascript`, `github_actions`) are unchanged.

---

## Comment triggers (not labels)

Some commands look like labels but are actually comment triggers handled by `approval-worker.yml`. They do not appear in the GitHub label sidebar.

| Comment | Effect |
|---|---|
| `/review` (or a comment containing `review`) | Asks the approval bot to recompute the PR's approval state and post a status update. |

If you previously thought "review" was a label, it's not — it's an issue/PR comment that the worker reacts to.

---

## See also

- [`docs/ci/TEAMS.md`](TEAMS.md) — who is in `qvac-internal-dev` / `merge` / `release` / `qvac-external`, and what they can do.
- [`.github/actions/label-gate/README.md`](../../.github/actions/label-gate/README.md) — full `label-gate` trust model and configuration reference.
- [`docs/gitflow.md`](../gitflow.md) — branch model and release flow.
