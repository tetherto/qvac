# PR Labels — CI reference

Single source of truth for every label that affects CI behaviour in this repo.

> **Convention** — apply labels via the GitHub PR sidebar. The CI reaction is event-driven and usually visible within ~30s.

---

## `verified` — secret-bearing CI authorisation

This is the **single** label that gates every privileged PR job in the repo. The legacy `verify` label has been retired — `verified` is now the only authorisation label CI reads.

| | |
|---|---|
| **Purpose** | Authorise the `label-gate` composite action so that secret-bearing jobs (sanity-checks, prebuilds, publish, deploy, etc.) are allowed to run on a PR. |
| **Who can apply** | Active member of `@tetherto/qvac-internal-dev`, `@tetherto/qvac-internal-merge`, `@tetherto/qvac-internal-release`, or `@tetherto/qvac-collabora`. See [TEAMS.md](TEAMS.md). |
| **What it gates** | Every secret-bearing workflow under `.github/workflows/` (108 workflows as of QVAC-18612). Specifically, every job downstream of `needs: [..., label-gate]` whose `if:` includes `needs.label-gate.outputs.authorised == 'true'`. |
| **Behaviour on `synchronize`** | When a non-trusted actor pushes new commits to a verified PR, `label-gate` strips the label automatically. A trusted actor must re-apply it after reviewing the new commits. This prevents authorisation from silently inheriting across content changes by an untrusted contributor. |
| **Behaviour on apply by non-trusted actor** | The label is stripped immediately and the gate denies. This avoids a "look, it's verified" social signal that doesn't actually mean the PR is authorised. |
| **Approval bot tier** | Recognised as **tier 1** by `approval-check-worker`. |
| **Stage selection** | On every [label-gated addon workflow](#granular-ci-routing-labels), `verified` authorises the PR and runs the baseline verified checks (`sanity-checks`, `cpp-lint`, and `ts-checks` where present) only — it no longer triggers the full pipeline by itself. Each expensive stage additionally needs its [granular routing label](#granular-ci-routing-labels). |
| **Implementation** | [`.github/actions/label-gate/README.md`](../../.github/actions/label-gate/README.md) — full trust model, exit policy, and test coverage. |

### When CI is blocked by `label-gate`

If your PR's secret-bearing jobs are skipping with a `label-gate.outputs.authorised != 'true'` condition, ask any member of the trusted teams above to apply `verified`. There is intentionally no self-service path — the whole point of the gate is that someone other than the PR author signs off.

---

## Granular CI-routing labels

The label-gated addon PR workflows use a shared **[`ci-router`](../../.github/actions/ci-router/action.yml)** composite action that reads the PR's labels and selects which expensive stages run, so routine PRs stay cheap and a reviewer can opt a PR into the heavy matrix on demand. Because the routing (and prebuild caching) lives in shared composite actions read from the repo's default branch, the behaviour is **identical across every workflow below** and a single change propagates to all of them.

**Wired in today** (`verified` = authorise-only; stages selected by the granular labels):

- `on-pr-llm-llamacpp.yml`
- `on-pr-embed-llamacpp.yml`
- `on-pr-vla.yml`
- `on-pr-tts-ggml.yml`
- `on-pr-diffusion-cpp.yml`
- `on-pr-ocr-ggml.yml`
- `on-pr-transcription-parakeet.yml`
- `on-pr-translation-nmtcpp.yml`
- `on-pr-transcription-whispercpp.yml`

**Being migrated onto the same shared composites** (run their prior CI until then): `ocr-onnx`, `bci-whispercpp`, `classification-ggml`, `tts-onnx`, `decoder-audio`, `onnx`.

> **Security invariant** — every stage below *also* requires `verified` (the trust gate). A granular label on its own — without `verified` — triggers **nothing**, so an untrusted contributor can never self-route into a secret-bearing job. `verified` alone authorises the PR and runs the baseline verified checks (`sanity-checks`, `cpp-lint`, and `ts-checks` where present), but no longer runs the full pipeline.

| Label | Runs | Pulls in prebuilds? |
|---|---|---|
| `prebuilds` | The multi-platform prebuild matrix, or a cache restore when native files are unchanged (see below). | — |
| `run-cpp-addon-tests` | C++ unit tests. Builds the addon itself, so it does **not** depend on the prebuild matrix. | No |
| `run-desktop-addon-tests` | Desktop integration tests. | Yes (implied) |
| `run-mobile-addon-tests` | Mobile (Android / iOS via AWS Device Farm) integration tests. | Yes (implied) |

Labels combine freely — e.g. `verified` + `run-desktop-addon-tests` + `run-mobile-addon-tests` builds prebuilds once and then runs both test suites. A manual `workflow_dispatch` run bypasses routing and runs everything.

> **Prebuild caching** — when a PR changes no native files (`*.cpp` / `*.hpp` / `*.c` / `*.h`, any `CMakeLists.txt`, `vcpkg.json` / `vcpkg-configuration.json`, or anything under `vcpkg/`), the prebuild matrix is skipped and binaries are **reused from the PR's most recent prior run** that carries a matching marker artifact (`prebuilds-cache-pr-<number>-<native_hash>`). This artifact-based reuse works under `pull_request_target`, where `actions/cache` writes are rejected. The marker is scoped by **PR number**, so a PR can only ever reuse its own prebuilds — no cross-PR reuse. The first run on a PR always builds; any native change moves the hash and forces a fresh build. Implemented by the shared [`detect-native-changes`](../../.github/actions/detect-native-changes/action.yml), [`prebuild-artifact-reuse`](../../.github/actions/prebuild-artifact-reuse/action.yml), and [`prebuild-artifact-save`](../../.github/actions/prebuild-artifact-save/action.yml) composites.

---

## No `release` label — npm publish authorisation lives in the `npm` environment

There is **intentionally no `release` (or similar) label** for authorising npm publishes. Publish authorisation is a single reviewer click on the dedicated `npm` GitHub Actions environment, scoped only to the `publish-*` jobs that consume `NPM_TOKEN` / OIDC. This keeps the publish gate visible in the GitHub Actions UI rather than buried in a label state, and it pairs with each package's npm Trusted Publisher configuration.

The legacy `release` environment is kept for backwards-compatibility while the `verified` flow rolls out; its reviewer requirement will be removed once the `npm` environment owns the publish gate end-to-end.

---

## Other CI-relevant labels

The following labels are recognised by CI workflows but are not part of the `label-gate` flow.

| Label | Purpose | Triggered by | Notes |
|---|---|---|---|
| `verified` | Canonical authorisation label — see the [`verified` section above](#verified--secret-bearing-ci-authorisation) for the full trust model. | `label-gate` composite action plus the `public-pr.yml`, `public-reusable-npm.yml`, `pr-test-inference-addon-cpp*.yml`, and `pr-models-validation-registry-server.yml` non-secret gates. | Replaces the legacy `verify` label, which was retired in favour of a single authorisation ceremony. |
| `prebuilds` | Addon CI routing — run the prebuild matrix, or reuse a prior run's prebuilds when native files are unchanged. Requires `verified`. | shared `ci-router` on the [label-gated addon workflows](#granular-ci-routing-labels) | Part of the granular routing scheme — see [Granular CI-routing labels](#granular-ci-routing-labels). |
| `run-cpp-addon-tests` | Addon CI routing — run the C++ unit tests. Requires `verified`. | shared `ci-router` on the [label-gated addon workflows](#granular-ci-routing-labels) | Does not pull in prebuilds (the cpp-test job builds the addon itself). |
| `run-desktop-addon-tests` | Addon CI routing — run desktop integration tests. Requires `verified`; implies `prebuilds`. | shared `ci-router` on the [label-gated addon workflows](#granular-ci-routing-labels) | See [Granular CI-routing labels](#granular-ci-routing-labels). |
| `run-mobile-addon-tests` | Addon CI routing — run mobile (Device Farm) integration tests. Requires `verified`; implies `prebuilds`. | shared `ci-router` on the [label-gated addon workflows](#granular-ci-routing-labels) | See [Granular CI-routing labels](#granular-ci-routing-labels). |
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

- [`docs/ci/SELF-HOSTED-RUNNERS.md`](SELF-HOSTED-RUNNERS.md) — Manual Workspace Cleanup, `working-directory: .`, and `runner.environment` on `qvac-*` workflows.
- [`docs/ci/TEAMS.md`](TEAMS.md) — who is in `qvac-internal-dev` / `merge` / `release` / `qvac-external`, and what they can do.
- [`.github/actions/label-gate/README.md`](../../.github/actions/label-gate/README.md) — full `label-gate` trust model and configuration reference.
- [`docs/gitflow.md`](../gitflow.md) — branch model and release flow.
