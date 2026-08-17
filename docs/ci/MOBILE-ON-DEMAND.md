# Mobile (Device Farm) tests — on-demand only

Per-addon mobile integration tests run on **AWS Device Farm**, which is expensive.
To cut that cost, they **no longer run automatically on PRs**. Instead you start
them by hand, choosing exactly one platform, the device(s) to run on, and
(optionally) a subset of tests.

This applies to all 14 mobile addons: `asr-ggml`, `audiogen-ggml`,
`bci-whispercpp`, `classification-ggml`, `decoder-audio`, `diffusion-cpp`,
`embed-llamacpp`, `inference-addon-cpp`, `llm-llamacpp`, `model-fit`, `ocr-ggml`,
`translation-nmtcpp`, `tts-ggml`, `vla`.

## How to run a mobile test

1. Go to **Actions → `Mobile Integration Tests (<addon>)`**.
2. Click **Run workflow** and fill in the inputs (below).
3. Click **Run workflow**.

### Inputs

| Input | What it does |
|-------|--------------|
| **platform** | The one platform this run targets — `Android` or `iOS`. A manual run is always a single platform. |
| **device** | A searchable dropdown of common pool devices (e.g. `Pixel 9`, `iPhone 17`). Pick `(custom)` if you want to type your own in `devices_custom`. |
| **devices_custom** | A free-text field for one **or more** device models, comma-separated (e.g. `Pixel 9, Pixel 8`). When set, it **overrides** the dropdown. Use it for new/uncommon devices or to run several at once. |
| **device_model_operator** | How the model name is matched: `CONTAINS` (any model containing the value — Device Farm picks by availability, so `Pixel 9` can also match `Pixel 9 Pro`) or `EQUALS` (that exact model only). |
| **tests** | Optional test filter — see [below](#the-tests-filter). Empty = the full mobile suite. |
| **ref** / **package** / … | Existing inputs (git ref, package spec, etc.) — unchanged. |

### Device selection: dropdown + free-text

You can pick a device two ways, and they combine:

- **Dropdown (`device`)** — the searchable list of common pool devices. Picks one.
- **Free-text (`devices_custom`)** — a comma-separated list; accepts **multiple**
  devices and any model name (handy for a device that isn't in the dropdown yet).
  If you fill this in, it wins over the dropdown.

Before any build or Device Farm run, a fast **`validate-devices`** job checks the
requested model(s) actually exist on Device Farm for the chosen platform. A typo
or an empty selection fails immediately, so you never pay for a wasted build or a
run that can't be scheduled.

### The `tests` filter

The `tests` input runs **only the tests you name**, so you don't pay to run the
whole suite. It is **by test name, not by file name.**

- It is a **[mocha](https://mochajs.org/) `--grep` regex**, matched against the
  mobile **test-runner names** — the `run*` functions in the addon's
  `test/mobile` tests (for sharded addons these are the names listed in
  `test/mobile/test-groups.json`). Examples: `runChatterboxSpeedTest`,
  `runLlmSpeedTest`.
- Combine several with `|`, e.g. `runLlmSpeedTest|runLlmMemoryTest`.
- Leave it **empty** to run the full mobile suite.

For sharded addons (e.g. `llm-llamacpp`, `ocr-ggml`), a `tests` filter collapses
the many shards into a single filtered run — a big cost saving. Leaving it empty
on a sharded addon runs the **full** shard set pinned to your chosen device(s),
which is many runs.

## What changed on PRs

- The `run-mobile-integration-tests` lane was removed from the `on-pr-*`
  workflows so opening/updating a PR no longer launches Device Farm. The
  mobile-only wrapper `on-pr-inference-addon-cpp.yml` had its automatic
  `pull_request_target` trigger disabled instead (it has no other lane); its
  gating machinery is preserved.
- Mobile status was **dropped from the Merge Guard**: it is no longer a required
  (or optional-but-reported) check, so a mobile run can never block a merge.
- The **`run-mobile-addon-tests` label is kept** but no longer starts a standalone
  mobile suite. It still gates the on-device (Device Farm) co-load smoke where
  that exists. See [LABELS.md](./LABELS.md).

## What did **not** change

The reusable (`workflow_call`) paths are untouched — benchmarks, the weekend run,
and on-merge triggers still call the same `integration-mobile-test-<addon>.yml`
workflows with their existing inputs and scheduling (sharded / dual-flagship /
single-pool). The on-demand behaviour is additive and only kicks in for a direct
`workflow_dispatch` run.

## Re-enabling automatic PR runs (later)

Everything needed to bring back the PR lane is intentionally preserved: the
`run-mobile-addon-tests` label, the `ci-router` `run_mobile` output, and the
gating jobs. Re-add the `run-mobile-integration-tests` job to the relevant
`on-pr-*` workflow to turn it back on. For `inference-addon-cpp`, also restore the
`pull_request_target` trigger in `on-pr-inference-addon-cpp.yml`.
