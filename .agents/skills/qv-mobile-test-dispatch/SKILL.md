---
name: qv-mobile-test-dispatch
description: Start an AWS Device Farm mobile integration test for an addon and pick the right prebuild source, so the run tests the binary the developer means rather than the published release. Covers run ids, GPR dev builds, published pins, test filters, device names, and reading the result. Use when someone asks to run mobile tests, test an addon on a device/phone, test a native change on mobile, or invokes /qv-mobile-test-dispatch.
disable-model-invocation: true
---

# mobile-test-dispatch

Mobile integration tests run on **AWS Device Farm**, which is billed per device
minute. They do not run automatically on PRs — someone dispatches them by hand,
choosing one platform, the device(s), and usually a test filter.

The part that goes wrong is **which binary ends up on the phone**. A dispatch
does not compile the addon; it installs a prebuilt one. Get that wrong and the
run is green against code nobody changed.

Canonical reference: [`docs/ci/MOBILE-ON-DEMAND.md`](../../../docs/ci/MOBILE-ON-DEMAND.md).
Read it once per session before answering detailed questions; this skill is the
operating procedure, that doc is the source of truth.

## When to use this skill

- "Run mobile tests for `<addon>`"
- "Test my native change on a device / on a phone"
- "Why did my mobile run test the wrong build?"
- "How do I get a run id?"

## Safety rules

- **Device Farm costs money.** Never dispatch the full suite to explore. Always
  pass a `tests` filter and the smallest device set that answers the question.
- **`llm-llamacpp` is sharded** (7 Android groups, 13 iOS groups). An empty
  `tests` filter fans out the whole set as separate Device Farm runs. Always
  filter for LLM.
- **One platform per dispatch.** Android and iOS are separate runs.
- **A second dispatch of the same workflow on the same branch cancels the
  first.** To cover both platforms, either wait, or use different addons in
  parallel.
- Never dispatch on someone's behalf without telling them it bills Device Farm.

## Step 1 — decide which binary should be tested

| goal | input |
|---|---|
| my own PR's native change | `prebuild_run_id=<run id>` |
| a build from another branch, or a published release | `package=@tetherto/<addon>-mono@<dev>` or `package=@qvac/<addon>@<ver>` |
| just the published release | leave both empty |

`prebuild_run_id` and `package` are **mutually exclusive** — setting both fails
with a message telling you to clear one.

The input is named `package` on most addons but **`package_spec`** on
`asr-ggml`, `audiogen-ggml`, `tts-ggml`. `prebuild_run_id` is the same everywhere.

## Step 2 — get a run id (only for the `prebuild_run_id` route)

**First: the PR must have built prebuilds at all.** The prebuild stage is
label-gated by `ci-router` — it runs only when the PR carries `prebuilds`,
`run-desktop-addon-tests`, or `run-mobile-addon-tests`. With none of those there
is no bundle and no run id. Add the `prebuilds` label and let CI re-run.

**Then:** open the PR's Checks tab, click the run that built the prebuilds, and
take the number at the end of its URL.

Do **not** filter by the addon's own workflow name. Which workflow built the
bundle varies — `on-pr-nx.yml` for most addons, `on-pr-<addon>.yml` for some,
`on-merge-<addon>.yml` for a branch build. Scope by the PR's head commit:

```bash
PKG=llm-llamacpp   # the package directory name, i.e. packages/<PKG>
PR=1234

SHA=$(gh pr view "$PR" --repo tetherto/qvac --json headRefOid --jq .headRefOid)
for rid in $(gh api "repos/tetherto/qvac/actions/runs?head_sha=$SHA&per_page=100" \
               --jq '.workflow_runs[].id'); do
  gh api "repos/tetherto/qvac/actions/runs/$rid/artifacts?per_page=100" \
    --jq ".artifacts[]|select(.name==\"prebuilds-$PKG\" and .expired==false)|.name" \
    2>/dev/null | grep -q . && { echo "$rid"; break; }
done
```

Nothing printed means either the label is missing, or — on the nx path — that run
only built the addons it considered affected and yours was not one. The dispatch
failure message lists which addons a run did build.

## Step 3 — pick a valid test filter

`tests` is a mocha `--grep` over runner **names**, not file names. A name that
matches nothing is rejected up front by `validate-devices`, for free, with the
list of valid names — so a wrong guess costs nothing but a round trip.

Read the names from the same source `validate-devices` uses:

```bash
# sharded addons (llm-llamacpp, diffusion-cpp, tts-ggml, audiogen-ggml, vla, ...)
jq -r '(.android//{})|[..|strings]|unique|.[]' packages/<PKG>/test/mobile/test-groups.json

# single-spec addons
grep -oE '\brun[A-Z][A-Za-z0-9_]*' packages/<PKG>/test/mobile/integration.auto.cjs | sort -u
```

**Known trap:** a name valid in `test-groups.json` can still be rejected
on-device by the model pre-stage step, which keeps its own `MODEL_SHARDS` list in
`packages/<PKG>/scripts/generate-prestage-block.js`. When the two drift you get
`[prestage] FATAL: tests grep /<name>/ matched no known runner`. Confirmed for
`vla-ggml` / `runEsmNamedExportsTest`. If you hit it, pick a name present in both.

## Step 4 — dispatch

```bash
gh workflow run integration-mobile-test-<addon>.yml --repo tetherto/qvac --ref <branch> \
  -f platform=Android \
  -f devices_custom="Google Pixel 9" \
  -f device_model_operator=EQUALS \
  -f tests=<runnerName> \
  -f prebuild_run_id=<run id>
```

- `devices_custom` takes a comma-separated list and overrides the `device`
  dropdown. Names are full fleet names (`Google Pixel 9`, `Apple iPhone 16 Pro`).
- `device_model_operator=EQUALS` bills exactly that model; `CONTAINS` may pick a
  different variant.
- `ref` selects the JS harness, tests and app — **not** the native binary. It and
  the prebuild source are deliberately independent.

## Step 5 — read the result

The build job's setup phase prints the provenance:

```
Verified: prebuilds come from run <id> — artifact 'prebuilds-<pkg>',
workflow '<name>', head <sha>, branch <branch> (<repo>), <conclusion>
```

Check the **head SHA** is the commit you meant — a run id resolves whether or not
it built the code under review.

Warnings worth acting on:

- `run <id> concluded 'failure'` — the source run was red. Its prebuild job may
  still be the green part, but confirm.
- `run <id> built code from the FORK '<repo>'` — normal for a fork PR (the repo
  is fork-first), but confirm you meant that contributor's code.

The run-id path **fails closed** — a wrong, private, unfinished or expired run id
fails the run with the reason rather than falling back to `@latest`.

## Per-addon notes

| addon | note |
|---|---|
| `llm-llamacpp` | sharded — always pass `tests` |
| `asr-ggml`, `audiogen-ggml` | `@qvac/*` publishes **no mobile prebuilds**, so an empty input cannot work. Use `prebuild_run_id` or the GPR `-mono` build. |
| `audiogen-ggml` | pins its composite actions to the default branch, so `prebuild_run_id` only works once that support is on `main`; it fails loudly with instructions until then |
| `vla` | package dir is `packages/vla-ggml`, workflow slug is `vla` |
| `decoder-audio` | no native prebuild of its own (rides `bare-ffmpeg` from npm). `package` has no effect; use `ref`. |
| `inference-addon-cpp` | compiles its own prebuilds in-run from the dispatched `ref`, so no prebuild input is needed or offered |

## Known harness gap

When an on-device test fails, the app-side log flush errors
(`[bare-log] after flush failed: The first argument must be of type string…`) on
every run, pass or fail. The reason a runner reported FAIL is therefore usually
not in the artifacts — only the harness assertion at `app.test.js`. Reproduce
locally or raise it with the mobile test framework owners rather than guessing
from the Device Farm logs.
