# Mobile (Device Farm) tests — on-demand only

Per-addon mobile integration tests run on **AWS Device Farm**, which is expensive.
To cut that cost, they **no longer run automatically on PRs**. Instead you start
them by hand, choosing exactly one platform, the device(s) to run on, and,
where supported, a subset of tests.

This applies to all 15 mobile addons: `asr-ggml`, `audiogen-ggml`,
`bci-whispercpp`, `classification-ggml`, `decoder-audio`, `diffusion-cpp`,
`embed-llamacpp`, `ggml-rpc-server`, `inference-addon-cpp`, `llm-llamacpp`,
`model-fit`, `ocr-ggml`, `translation-nmtcpp`, `tts-ggml`, `vla`.

Except for its dedicated section, the guidance below applies to the other 14
addons. `ggml-rpc-server` has different device inputs and no test filter or
package input; use its [dispatch example](#ggml-rpc-server-dispatch) instead.

## How to run a mobile test

1. Go to **Actions → `Mobile Integration Tests (<addon>)`**.
2. Click **Run workflow** and fill in the inputs (below).
3. Click **Run workflow**.

> Agents (Claude Code, Codex, Cursor) can walk you through this: the
> `qv-mobile-test-dispatch` skill in `.agents/skills/` is the operating procedure
> built on this page.

### ggml-rpc-server dispatch

This workflow accepts `platform`, `android_device` or `ios_device`, `ref`,
`workdir`, and `prebuild_run_id`. It does **not** accept `device`,
`devices_custom`, `device_model_operator`, `tests`, or `package`. A run exercises
its complete managed RPC lifecycle probe on the selected device.

To test prebuilds already produced for your PR, find the run id as described in
the [quick start below](#quick-start--test-your-own-pr-on-a-device), then dispatch:

```bash
PR=1234 # your PR number
gh workflow run integration-mobile-test-ggml-rpc-server.yml --repo tetherto/qvac \
  --ref main -f ref="refs/pull/$PR/head" \
  -f platform=Android -f android_device="Google Pixel 9" \
  -f prebuild_run_id="${RUN_ID:?refusing to dispatch with an empty run id}"
```

The workflow runs from upstream `main`; its `ref` input checks out your PR's
head from the upstream pull-request ref, so your branch need not exist upstream.
For iOS, use `-f platform=iOS -f ios_device="Apple iPhone 16 Pro"` instead of
the Android platform and device inputs. Without `prebuild_run_id`, a standalone
dispatch builds prebuilds from the selected ref in the same run before packaging
the device app. With a run id, it skips that build and installs the named run's
artifact, failing if the artifact cannot be used.

### Quick start — test your own PR on a device

For the other 14 addons, this is the common case end to end. A first run should
cover every supported device and every test — see
[Which devices to run on](#which-devices-to-run-on).
The single-device, single-test form below is the follow-up shape: once you are
re-running a known failure or iterating on one test, narrow it, because Device
Farm is billed per device minute.

```bash
WF=llm-llamacpp             # workflow slug: integration-mobile-test-$WF.yml
PKG=llm-llamacpp            # package dir: packages/$PKG (vla is the odd one: vla vs vla-ggml)
PR=1234
BRANCH=$(git branch --show-current)

# 0. Your PR must carry the `prebuilds` label (or run-desktop/run-mobile-addon-tests),
#    or CI builds no prebuilds and there is no run id to point at.

# 1. The run that built YOUR addon's bundle for THIS commit, whatever workflow built it.
SHA=$(gh pr view "$PR" --repo tetherto/qvac --json headRefOid --jq .headRefOid)
for rid in $(gh api "repos/tetherto/qvac/actions/runs?head_sha=$SHA&per_page=100" \
               --jq '.workflow_runs[].id'); do
  gh api "repos/tetherto/qvac/actions/runs/$rid/artifacts?per_page=100" \
    --jq ".artifacts[]|select(.name==\"prebuilds-$PKG\" and .expired==false)|.name" \
    2>/dev/null | grep -q . && { RUN_ID=$rid; break; }
done
echo "run id: $RUN_ID"

# 2. A valid test filter (a mocha --grep over runner NAMES).
jq -r '(.android//{})|[..|strings]|unique|.[]' packages/$PKG/test/mobile/test-groups.json 2>/dev/null \
  || grep -oE '\brun[A-Z][A-Za-z0-9_]*' packages/$PKG/test/mobile/integration.auto.cjs | sort -u

# 3. Dispatch. Android and iOS are separate runs, and a second dispatch of the
#    same workflow on the same branch cancels the first.
gh workflow run integration-mobile-test-$WF.yml --repo tetherto/qvac --ref "$BRANCH" \
  -f platform=Android \
  -f devices_custom="Google Pixel 9 Pro" \
  -f device_model_operator=EQUALS \
  -f tests=<runnerName> \
  -f prebuild_run_id="${RUN_ID:?refusing to dispatch with an empty run id}"
```

Then check the build job's setup step printed the run and commit you meant:

```
Verified: prebuilds come from run <id> — artifact 'prebuilds-<pkg>', …, head <sha>, branch <branch> (<repo>), success
```

**Common stops**, all of which fail fast and for free:

| message | meaning |
|---|---|
| `tests filter '<x>' matches none of the N known runners` | wrong runner name — the error lists the valid ones |
| `Run <id> has no 'prebuilds-<pkg>' … That run built prebuilds for: …` | that run did not build your addon (nx only builds affected ones) |
| `Run <id> is still '<status>'` | the prebuild job has not uploaded yet — wait, same run id |
| `prebuild_run_id and a pinned package are mutually exclusive` | clear whichever of the two you did not mean |
| `[prestage] FATAL: tests grep /<x>/ matched no known runner` | the name is in neither the addon's `test-groups.json` nor its `integration.auto.cjs` — a typo; take one from the lists above |

### Inputs

| Input | What it does |
|-------|--------------|
| **platform** | The one platform this run targets — `Android` or `iOS`. A manual run is always a single platform. |
| **device** | A searchable dropdown of common pool devices. Pick `(custom)` if you want to type your own in `devices_custom`. The dropdown predates the current supported roster, so for a first run prefer `devices_custom` — see [Which devices to run on](#which-devices-to-run-on). |
| **devices_custom** | A free-text field for one **or more** device models, comma-separated (e.g. `Google Pixel 9 Pro, Samsung Galaxy S25 Ultra`). When set, it **overrides** the dropdown. This is how you run the full supported set in one dispatch. |
| **device_model_operator** | How the model name is matched: `EQUALS` (**default** — that exact fleet model only; dropdown values are exact fleet names) or `CONTAINS` (any model containing the value — Device Farm picks by availability, so `Pixel 9` can also match `Pixel 9 Pro`). Default is `EQUALS` so a single-device run bills exactly the model you picked. |
| **tests** | Optional test filter — see [below](#the-tests-filter). Empty = the full mobile suite. |
| **prebuild_run_id** | The run id whose `prebuilds` artifact holds the native binaries to install. **This is the route for testing your own PR on a device** — see [below](#testing-unmerged--unpublished-native-code). Outranks `package`, and a wrong or expired run id **fails the run** instead of quietly resolving `@latest`. |
| **package** (or **package_spec**) | Which *published* build to put on the phone — see [below](#which-build-gets-tested). Default **empty** resolves the **published `@qvac/<addon>@latest`** on a manual run, *not* your branch — a manual dispatch builds no prebuild artifacts of its own. Use it for a release or a build from **another** branch; for your own PR prefer `prebuild_run_id`. Mutually exclusive with it. |
| **ref** | Git ref to check out for the **test harness / app** (not the native binary — see below). |

### Which devices to run on

**The first run on an addon is the full matrix: every supported device, every
test.** That is what tells you whether the change is good. Narrow only after it
is green, when you are re-running a known failure or iterating on one test.

| Platform | Supported devices |
|----------|-------------------|
| Android  | `Google Pixel 9 Pro`, `Samsung Galaxy S25 Ultra`, `Samsung Galaxy S26 Ultra` |
| iOS      | `Apple iPhone 16 Pro`, `Apple iPhone 17 Pro` |

Leave `tests` empty to run the addon's whole suite. Android and iOS are separate
dispatches, and **the second cancels the first if the Android run is still
going** — the concurrency group is keyed on workflow and ref, not platform (see
[One run at a time](#one-run-at-a-time-per-branch)). So a full
first pass is two runs, in sequence:

```bash
gh workflow run integration-mobile-test-$WF.yml --repo tetherto/qvac --ref "$BRANCH" \
  -f platform=Android \
  -f devices_custom="Google Pixel 9 Pro, Samsung Galaxy S25 Ultra, Samsung Galaxy S26 Ultra" \
  -f device_model_operator=EQUALS \
  -f prebuild_run_id="${RUN_ID:?refusing to dispatch with an empty run id}"

# iOS — only after the Android run finishes, or it cancels it
gh workflow run integration-mobile-test-$WF.yml --repo tetherto/qvac --ref "$BRANCH" \
  -f platform=iOS \
  -f devices_custom="Apple iPhone 16 Pro, Apple iPhone 17 Pro" \
  -f device_model_operator=EQUALS \
  -f prebuild_run_id="${RUN_ID:?refusing to dispatch with an empty run id}"
```

**Not supported.** Adding these to `devices_custom` will schedule and bill a run,
but a failure on one is not a failure the team acts on:

- **Pixel 8 and anything older.** Below the floor the addons target.
- **Pixel 10.** Not adopted; it is deferred in the perf fleet too.

You can still add any other fleet device deliberately — to reproduce a report on
specific hardware, say. Note it in the PR so a reviewer knows why the device list
is not the standard one.

**`Google Pixel 9` is not `Google Pixel 9 Pro`.** Under the default `EQUALS`
operator they are different fleet models, and the supported one is the Pro.

### Device selection: dropdown + free-text

You can pick a device two ways, and they combine:

- **Dropdown (`device`)** — the searchable list of common pool devices. Picks one.
- **Free-text (`devices_custom`)** — a comma-separated list; accepts **multiple**
  devices and any model name (handy for a device that isn't in the dropdown yet).
  If you fill this in, it wins over the dropdown.

Before any build or Device Farm run, a fast **`validate-devices`** job checks, up
front (so you never pay for a wasted build or an unschedulable run):

- the requested model(s) **exist** on Device Farm for the chosen platform;
- the `tests` filter (if any) **matches at least one real runner** — a typo that
  would otherwise run zero tests and pass green is rejected here. This now covers
  **every addon**: sharded addons validate against their `test-groups.json`,
  single-spec addons against their committed `test/mobile/integration.auto.cjs`,
  and `inference-addon-cpp` regenerates its runner map (one shard per desktop
  suite) at validation time;
- the **total run count** (`specs × devices`) is within the cap (see
  [Run-count cap](#run-count-cap-fail-fast)).

A typo, an empty selection, an unknown test filter, or an oversized fan-out fails
immediately and for free.

### Valid device names

A device name is matched as a **`MODEL`** value on Device Farm. **The fleet uses
full manufacturer-prefixed names** (e.g. `Google Pixel 9`, not `Pixel 9`). How the
match works depends on `device_model_operator`:

- **`EQUALS`** (default): your value must be the **exact** fleet model — `Pixel 9`
  is rejected; you must pass `Google Pixel 9`. The dropdown values are already
  exact fleet names, so the default just works and bills exactly the model you
  picked.
- **`CONTAINS`**: your value need only be a substring — `Pixel 9` matches
  `Google Pixel 9` (and `Google Pixel 9 Pro`, `Google Pixel 9a`, …). Use it only
  for a deliberate shorthand match; on a single-device run it can pick a
  different (and slower) variant than you intended.

> **Keep `EQUALS` (the default) for multi-device runs.** Because `CONTAINS` selectors can
> overlap (`Google Pixel 9` and `Google Pixel 9 Pro` both match
> `Google Pixel 9 Pro`), two selectors could land on the **same** physical model
> and bill it twice. `validate-devices` now rejects overlapping selections up
> front, so for any `devices_custom` list with more than one entry pass exact,
> distinct fleet names with `-f device_model_operator=EQUALS`.

The dropdown uses **exact** names so they work with either operator:

| Platform | Supported `MODEL` values | Manufacturer |
|----------|--------------------------|--------------|
| Android  | `Google Pixel 9 Pro`, `Samsung Galaxy S25 Ultra`, `Samsung Galaxy S26 Ultra` | `Google` / `Samsung` |
| iOS      | `Apple iPhone 16 Pro`, `Apple iPhone 17 Pro` | `Apple` |

These are the models the team supports — see
[Which devices to run on](#which-devices-to-run-on). The fleet carries others,
and `devices_custom` will happily run them; they are simply not what a result is
judged against.

`devices_custom` accepts any of the above, a bare substring (with `CONTAINS`), or
any other model on the fleet. **This table can drift** as the fleet changes, so the
authoritative list is Device Farm itself. Two ways to see it:

1. **Let the workflow tell you (easiest).** Dispatch the run with a made-up device
   (e.g. `devices_custom: nope`). The `validate-devices` job fails fast and prints
   **`Available <PLATFORM> device models:`** — the full, current model list for that
   platform. No build or Device Farm run is charged.
2. **Query AWS directly** (needs Device Farm read access; region is `us-west-2`):

```bash
aws devicefarm list-devices \
  --filters '[{"attribute":"PLATFORM","operator":"EQUALS","values":["ANDROID"]}]' \
  --query 'devices[].model' --output json | jq -r '.[]' | sort -u
```

Swap `ANDROID` for `IOS` for the iOS list.

### The `tests` filter

The `tests` input runs **only the tests you name**, so you don't pay to run the
whole suite. It is **by test name, not by file name.**

- It is a **[mocha](https://mochajs.org/) `--grep` regex**, matched against the
  mobile **test-runner names** in the addon's `test/mobile` tests (for sharded
  addons these are the names listed in `test/mobile/test-groups.json`). Most
  addons name these `run*` (e.g. `runChatterboxSpeedTest`, `runLlmSpeedTest`),
  but the exact names are addon-specific — audiogen, for instance, uses
  `testLoadModels`, `testGenerateMusicOnGpu`. Always check the addon's runner
  source (or its `test-groups.json`) for the exact names to pass.
- Combine several with `|`, e.g. `runLlmSpeedTest|runLlmMemoryTest`. A partial
  pattern works too: `runChatterbox` runs (and pre-stages models for) every
  runner whose name matches.
- Leave it **empty** to run the full mobile suite.

For sharded addons (e.g. `llm-llamacpp`, `ocr-ggml`), a `tests` filter collapses
the many shards into a single filtered run — a big cost saving. Leaving it empty
on a sharded addon runs the **full** shard set pinned to your chosen device(s),
which is many runs.

**A typo can't waste money or pass green.** For **every** addon the
`validate-devices` job matches your filter against the real runner names *before*
any build, and fails fast (printing the known runners) if it matches none — so a
mistyped filter can't reach the device, select zero tests, and report a false
pass. Model pre-staging follows the same regex: only the models the matched
runners need are staged; anything unmatched is simply fetched on-device (a
partial pattern like `runBenchmarkPerf` stages every shard it selects, not
nothing). On the automated `workflow_call` lanes (weekend / on-merge /
benchmarks) — which never run `validate-devices` — pre-staging **fails closed**
if the shard grep matches no known runner, so a `test-groups` ↔ model-map drift
surfaces instead of silently shipping an under-staged run. (`vla-ggml` is the one
exception: its manifest is built from presigned URLs that may legitimately be
absent, so it fails closed only when the grep matches no known runner *name*,
and still falls back to on-device download when a known runner's URL isn't baked
yet.)

#### Where to find the test names (per addon)

The valid names live in the addon repo, under its mobile test folder:

- **Sharded addons** (they ship `test/mobile/test-groups.json`): the exact grep
  strings are the values inside that file — e.g.
  `packages/llm-llamacpp/test/mobile/test-groups.json`,
  `packages/ocr-ggml/test/mobile/test-groups.json`. Every listed test is a valid
  `tests` value; a group's whole set is those names joined with `|`.
- **All addons**: the runnable names are the `run*` functions declared in the
  generated `packages/<addon>/test/mobile/integration.auto.cjs` (grep for
  `async function run`). These are exactly what the mobile run greps against.

If in doubt, run once **without** a filter and open the Device Farm run's
`bare_console.log` / the "Run → tests" legend on the job summary — it enumerates
the `run*` names that executed, which you can then narrow with `tests`.

### Where the logs are when a run fails

`test-results.json` only records the harness assertion, which is the same for
every failure. The reason is in the app's own output:

| what | Android | iOS |
|---|---|---|
| JS / bare runtime, TAP, the failure | `logcat_full.txt`, `bare` tag | `bare_console.log` |
| **native C++ / engine** | `logcat_full.txt`, `bare` tag, `[C++ TEST]` prefix | `bare_console.log`, `[C++ TEST]` prefix |

```bash
gh run download <run-id> --repo tetherto/qvac --dir ./logs
grep -aE "E bare|I bare" logs/**/*logcat_full.txt   # Android: test + native
grep -a "\[C++ TEST\]"    logs/**/*bare_console.log  # iOS: native
```

Use `logcat_full.txt`, **not** the smaller `Logcat.logcat`, and grep the `bare`
tag rather than TAP markers — the runtime prints through logcat, so `ok 1` never
appears as a raw line. There is no `bare_console.log` on Android by construction
(private app data, unreadable by adb on a release-signed APK).

### Which build gets tested

For the shared addon workflows, a manual run does **not** compile the native
addon — it installs a **prebuilt** one. Sources are tried in this order:

- **`prebuild_run_id=<run id>`** → install the `prebuilds` artifact **that run
  already built**. Highest precedence: when set, every source below is skipped,
  and resolution **fails closed** — a run id that is wrong, private, builds no
  prebuilds, or whose artifact has expired fails the run rather than sliding
  back to `@latest`. This is the route for testing **your own PR**; see
  [below](#testing-unmerged--unpublished-native-code).
- **Empty (default)** → artifact-first resolution: prebuild artifacts **from the
  same run**, then the published **`@qvac/<addon>@latest`** if there are none.
  A standalone dispatch builds no prebuilds of its own, so in practice **empty
  means `@latest`** — the published release, *not* your branch's native code.
  Same-run artifacts only exist when the mobile workflow is invoked via
  `workflow_call` from a run that built them (for example, on-merge, benchmark,
  or weekend runs).
- **`@qvac/<addon>@1.2.3`** → force-install that exact **published npm** version.
- **`@tetherto/<addon>-mono@<dev-version>`** → force-install a specific **branch
  build** from GitHub Packages (GPR). Note the **`-mono`** suffix: that is the
  name `publish-library-to-gpr` actually publishes (`name-suffix: "-mono"` in
  every `on-merge-*.yml`). The un-suffixed `@tetherto/<addon>` packages are dead
  leftovers or do not exist. Setting any non-empty spec flips
  `force-npm-prebuild` on.

`prebuild_run_id` and `package` are two different answers to "which binary goes
on the phone", so setting **both is an error** — the run fails and tells you to
clear one, rather than picking for you.

### Testing unmerged / unpublished native code

For the shared addon workflows, `--ref <branch>` gives you the branch's JS
harness, tests and app — but **never** its compiled `.bare`. If your change
touches `addon/src/**`, the run otherwise exercises your new tests against the
**published** engine and passes for the wrong reason. That has happened: a PR
ran mobile on five addons, went green on all of them, and every run had
`package` empty — so each one installed the published release instead of the
~300 lines of new C++ under review.

Two routes. Pick by **whose build you need**.

#### Route A — your own PR: `prebuild_run_id` (use this)

Your PR's `on-pr-<addon>` run already compiled the prebuilds. Point the mobile
dispatch at that run and it installs those exact binaries — **no `tmp-*` branch,
no On Merge dispatch, no wait for a publish, no hand-assembled package name.**

**First, your PR must have built prebuilds at all.** The prebuild stage is
**label-gated** by `ci-router`: it only runs when the PR carries `prebuilds`,
`run-desktop-addon-tests`, or `run-mobile-addon-tests`. With none of those there
is no bundle and no run id to point at — add the `prebuilds` label and let CI
re-run first.

**Where the run id comes from.** Easiest: open the PR's **Checks** tab, click the
run that built the prebuilds, and take the number at the end of its URL
(`.../actions/runs/<run id>`).

Do **not** assume it is your addon's own workflow. Which workflow builds the
bundle varies — `on-pr-nx.yml` for most addons, `on-pr-<addon>.yml` for some,
`on-merge-nx.yml` for a branch build — so filtering by workflow name is
unreliable. Scope by your PR's head commit instead:

```bash
PKG=llm-llamacpp   # the package directory name, i.e. packages/<PKG>
WF=llm-llamacpp    # workflow slug: integration-mobile-test-<WF>.yml. Not always
                   # $PKG — integration-mobile-test-vla.yml builds packages/vla-ggml.
PR=4519            # your PR number
BRANCH=$(git branch --show-current)

SHA=$(gh pr view "$PR" --repo tetherto/qvac --json headRefOid --jq .headRefOid)
RUN_ID=$(for rid in $(gh api "repos/tetherto/qvac/actions/runs?head_sha=$SHA&per_page=100" \
                        --jq '.workflow_runs[].id'); do
  gh api "repos/tetherto/qvac/actions/runs/$rid/artifacts?per_page=100" \
    --jq ".artifacts[]|select(.name==\"prebuilds-$PKG\" and .expired==false)|.name" \
    2>/dev/null | grep -q . && { echo "$rid"; break; }
done)

# An empty RUN_ID would dispatch the "unchanged" path and quietly resolve
# @qvac/<addon>@latest — the published-release-goes-green failure this whole
# route exists to close. Stop instead.
[ -n "$RUN_ID" ] || { echo "no run for $SHA carries prebuilds-$PKG (is the 'prebuilds' label on the PR?)" >&2; exit 1; }
echo "$RUN_ID"
```

That finds the run carrying **your addon's** bundle for **this commit**, whatever
built it. If it prints nothing, either the label is missing or — on the nx path —
that run only built the addons it considered affected, and yours was not one. The
dispatch failure message lists which addons a run did build, so a wrong guess
tells you where to look.

```bash
gh workflow run integration-mobile-test-$WF.yml --repo tetherto/qvac --ref $BRANCH \
  -f platform=Android \
  -f devices_custom="Google Pixel 9 Pro" \
  -f device_model_operator=EQUALS \
  -f prebuild_run_id="${RUN_ID:?refusing to dispatch with an empty run id}"
```

The build job's *Resolve prebuilds from a run id* step prints the provenance:

```
Verified: prebuilds come from run 33179656677 — artifact 'prebuilds-llm-llamacpp',
workflow 'On PR Trigger (LLM)', head 1d2c3b4…,
branch feat/backend-selection (tetherto/qvac), success
```

That line names the **head SHA** the binaries were built from. Check it against
your branch tip: a run id resolves whether or not it built the commit you meant,
so this is what tells you the binaries are the ones under review. The **`ref`**
input and the prebuild run are deliberately independent — that is what lets you
test a JS-only fix against prebuilds from an earlier commit — so nothing can
infer the mismatch for you.

This route **fails closed** by design. A run id that does not exist, that you
cannot read, that built no prebuilds, or whose artifact has aged out of
retention fails the run with the reason and what to do about it. It never falls
back to `@latest` — that silent fallback is the bug this route exists to remove.

Three things to know:

- **Artifacts expire.** Retention is set per repository, so an old run id stops
  working. Re-run the prebuild job on your PR and use the new run id.
- **The artifact must cover your platform.** A prebuild run whose iOS leg was
  cancelled still publishes a bundle, just without `ios-arm64`; the run fails
  with the directories the artifact does contain, rather than building an app
  around a missing binary.
- **`audiogen-ggml` is the exception.** It loads its composite actions from the
  default branch (a supply-chain guard for its `release`-environment job), so it
  only honours `prebuild_run_id` once that support is on the default branch.
  Until then the run fails with an explicit message rather than quietly
  installing `@latest` — use `-f package_spec=@tetherto/audiogen-ggml-mono@<dev>`
  in the meantime. Note that `@qvac/audiogen-ggml` publishes **no prebuilds**, so
  an empty input cannot work for this addon at all.
- **Check which repository built it.** This repo is fork-first, so a PR's
  `on-pr` run is usually `pull_request_target` on a *fork* — it appears in this
  repo's run list while its head repository is the contributor's fork. That is
  the normal case and is not blocked: a fork's prebuilds only exist because the
  merge/release team already approved `fork-ci` on that run. But the binaries do
  get bundled into an app and executed on org devices, so the provenance line
  names the head repository and a run from a **different** repository than the
  one you expected raises a `::warning::`. Read it before trusting a green run.

It also works for **`ocr-ggml` and `translation-nmtcpp`**, which Route B cannot
serve at all (see the note at the end of that section).

#### Route B — a build from another branch, or a published release

Route A needs a run you can point at. When you need someone *else's* branch, an
older commit whose artifact has expired, or a specific published version, pin a
package instead.

**Step 1 — publish a dev build of your branch.** Push it as `tmp-<TICKET>`; the
addon's *On Merge Trigger* workflow builds the prebuilds and publishes
`@tetherto/<addon>-mono@<pkg-version>-tmp.runid-<run id>` to GitHub Packages.

```bash
BRANCH=tmp-QVAC-1234
git push origin HEAD:refs/heads/$BRANCH
```

Wait for that run to finish — the mobile dispatch needs the package to exist.

**Step 2 — resolve the version it published.** The run id is the version suffix,
so you never have to read it out of a log:

Two names are involved and for one addon they differ, so set them separately
rather than deriving one from the other:

```bash
WF=llm-llamacpp             # workflow slug: integration-mobile-test-$WF.yml
GPR_NAME=llm-llamacpp-mono  # the npm package name (minus @qvac/) plus -mono

RUN_ID=$(gh run list --repo tetherto/qvac \
  --workflow on-merge-nx.yml --branch $BRANCH \
  --limit 1 --json databaseId --jq '.[0].databaseId')

PKG=$(gh api "orgs/tetherto/packages/npm/$GPR_NAME/versions?per_page=50" \
  --jq ".[] | select(.name | endswith(\"runid-$RUN_ID\")) | \"@tetherto/$GPR_NAME@\" + .name")

echo "$PKG"   # @tetherto/llm-llamacpp-mono@0.47.0-tmp.runid-33179656677
```

The 13 native addons publish from the single `on-merge-nx.yml`, so the run is
found by branch rather than by a per-addon workflow name. `model-fit` still has
its own `on-merge-model-fit.yml`.

For every addon except one, `GPR_NAME` is just `$WF-mono`. **`vla` is the
exception:** its mobile workflow is `integration-mobile-test-vla.yml`, but the
package is `@qvac/vla-ggml`, so `WF=vla` and `GPR_NAME=vla-ggml-mono`. If
unsure, read `addon-npm-name` from the mobile workflow and append `-mono` to the
part after the slash.

An empty `$PKG` means either that run published nothing — usually because the
push touched nothing under `packages/<addon>/`, so the path-scoped workflow
skipped — or that `GPR_NAME` is wrong. Check the name first:

```bash
gh api "orgs/tetherto/packages/npm/$GPR_NAME/versions?per_page=1" --jq '.[0].name'
```

A `Package not found` here means the name, not the run, is the problem.

**Step 3 — dispatch mobile against it.** Android first, then iOS (a second
dispatch on the same branch cancels the first — see the concurrency note below).

```bash
# Android
gh workflow run integration-mobile-test-$WF.yml --repo tetherto/qvac --ref $BRANCH \
  -f platform=Android \
  -f devices_custom="Google Pixel 9 Pro, Samsung Galaxy S25 Ultra" \
  -f device_model_operator=EQUALS \
  -f tests="runContinuousBatchingTest" \
  -f package="$PKG"

# iOS — only after the Android run finishes
gh workflow run integration-mobile-test-$WF.yml --repo tetherto/qvac --ref $BRANCH \
  -f platform=iOS \
  -f devices_custom="Apple iPhone 17 Pro, Apple iPhone 16 Pro" \
  -f device_model_operator=EQUALS \
  -f tests="runContinuousBatchingTest" \
  -f package="$PKG"
```

Drop `-f tests=` to run the full sharded suite — for LLM that is many Device Farm
runs, so prefer a filter while iterating.

**Step 4 — confirm the pin actually took effect.** The build job's *Download
prebuilds* step prints:

```
Verified: prebuilds come from @tetherto/<addon>-mono@<version> (pinned, GitHub Packages (npm.pkg.github.com))
```

If you instead see `downloading @qvac/<addon>@latest from npm (registry.npmjs.org)`,
the pin did not arrive and you are testing the published release.

**The Route B input is named `package` on most addons but `package_spec` on three.**
`prebuild_run_id` (Route A) has the same name everywhere:

| input | addons |
|---|---|
| `-f package=` | `bci-whispercpp`, `classification-ggml`, `decoder-audio`, `diffusion-cpp`, `embed-llamacpp`, `llm-llamacpp`, `model-fit`, `ocr-ggml`, `translation-nmtcpp`, `vla` |
| `-f package_spec=` | `asr-ggml`, `audiogen-ggml`, `tts-ggml` |
| *(no such input)* | `inference-addon-cpp` |
| `-f prebuild_run_id=` | every addon above **except** `decoder-audio` and `inference-addon-cpp` (see *Addons that need none of this*) |

**Addons that need none of this:** `inference-addon-cpp` compiles its `.bare` in
the same run from `ref`, and `decoder-audio` has no native prebuild of its own
(it rides on `bare-ffmpeg`'s, so its `package` input does not change what is
tested) — for both, plain `--ref <branch>` is enough, which is why neither
exposes `prebuild_run_id`.

> **Two addons publish no mobile prebuilds to npm.** `@qvac/asr-ggml` and
> `@qvac/audiogen-ggml` ship none, so an **empty** input cannot work for them —
> the run fails with "No prebuilds directory found in package". Their
> `@tetherto/<addon>-mono` dev builds *do* carry prebuilds, so Route B works; so
> does Route A. (`@qvac/decoder-audio` also ships none, but it needs no prebuilds
> of its own — see below.)

> The **`ref`** input defaults to **blank**, so the run checks out the branch you
> dispatch from (`gh workflow run … --ref <branch>` — no `-f ref=` needed). Pass
> `-f ref=<tag/sha>` only to override it. `ref` drives the JS test harness and
> the app; it does **not** drive the native prebuild, which always comes from an
> artifact (this run's, or the run named by `prebuild_run_id`) or a package
> (see above).
>
> The `tests`-filter / shard-count validation reads the runner list from the
> **same commit** the build executes, so if your branch renames or adds runners
> (or shards), `validate-devices` checks against your branch's list — a stale
> default-branch copy can't wave a mistyped filter through. A blank `ref` pins to
> the **exact commit** that triggered the run (`github.sha`), shared by every job,
> so a push mid-run can't make validation and build inspect different code. The
> composite actions themselves always run from the trusted workflow ref, never
> from `ref`.

**Exceptions:**

- **`inference-addon-cpp`** has no published package — it **compiles its `.bare`
  natively in the same run from `ref`**, so a branch dispatch already tests that
  branch's native code directly (no `package` input, none needed).
- **`decoder-audio`** has no native prebuild of its own (it rides on
  `bare-ffmpeg`'s), so its `package` input does not change what is tested.

### One run at a time (per branch)

Each mobile workflow has a concurrency guard: a new manual dispatch **cancels the
previous in-flight dispatch of the same workflow on the same branch**, so you can
never accidentally stack two Device Farm runs (and two bills). Dispatches on
**different branches are independent** — that is what lets a few test branches run
in parallel. The `workflow_call` paths (benchmarks / weekend / on-merge) are never
cancelled by this.

## Typical flow (worked example)

A manual run targets **one platform at a time** (the `platform` input is `Android`
*or* `iOS`), because each platform has its own device fleet. Covering both is just
two dispatches. The usual pattern is two steps:

### 1. Broad coverage — run the pool, per platform

Run the full suite across the phones you care about (one dispatch per platform):

```bash
# Android — across the pool phones (one run per exact model)
gh workflow run integration-mobile-test-tts-ggml.yml --ref <branch> \
  -f platform=Android \
  -f devices_custom="Google Pixel 9 Pro, Samsung Galaxy S25 Ultra, Samsung Galaxy S26 Ultra" \
  -f device_model_operator=EQUALS

# iOS — the iPhones
gh workflow run integration-mobile-test-tts-ggml.yml --ref <branch> \
  -f platform=iOS \
  -f devices_custom="Apple iPhone 16 Pro, Apple iPhone 17 Pro" \
  -f device_model_operator=EQUALS
```

Run the iOS dispatch only after the Android one finishes — same workflow, same
branch, so a second dispatch cancels the first. (Once the workflow is on
the default branch you can do the same from **Actions → Run workflow** in the UI.)

### 2. Narrow after a failure — one device, one test

When a device fails, don't re-run everything. Re-dispatch **just that device** with
**just the failing test** (`tests` is a mocha `--grep` on the runner name — see
[the tests filter](#the-tests-filter)):

```bash
# e.g. runChatterboxSpeedTest failed on the S26 Ultra — re-run only that
gh workflow run integration-mobile-test-tts-ggml.yml --ref <branch> \
  -f platform=Android \
  -f devices_custom="Samsung Galaxy S26 Ultra" \
  -f device_model_operator=EQUALS \
  -f tests="runChatterboxSpeedTest"
```

This is the cheap, fast loop for reproducing/fixing a single failure without paying
for the whole pool again.

**Attach the run to the PR.** A re-run is only evidence if a reviewer can open it,
so put its link in the PR. Prefer a **comment**: it appends, so nothing can be
lost and nothing has to be read back first. Use the description only when the
link belongs in the write-up itself.

```
Re-ran runChatterboxSpeedTest on Samsung Galaxy S26 Ultra after 4e1f2a9:
https://github.com/tetherto/qvac/actions/runs/<id> — total=1 passed=1
```

Say which **test** and which **device**, so the link is readable without opening
it.

Pass the text as a **file**, never as a shell argument:

```bash
# compose the note in /tmp/pr-<num>-note.md first
gh pr comment <num> --repo tetherto/qvac --body-file /tmp/pr-<num>-note.md
```

Backticks and `$(...)` inside a double-quoted argument run before `gh` does, and
on a fork PR the body and the run artifacts are written by someone else. Same for
`gh pr edit`: read the body to a file, append there, write it back with
`--body-file`. An agent doing this must show the text and the command and get
your approval first. Read the verdict from the run's `test-results.json` rather than the workflow
conclusion — a green workflow is not the same as a passed test, and Device Farm's
own `Totals:` line counts its own suite, not your runners. When a run is red, see
[Where the logs are when a run fails](#where-the-logs-are-when-a-run-fails).

### Run-count cap (fail-fast)

To stop a single dispatch from spraying the whole fleet, two safety rails are
enforced by `validate-devices` **before any build** (and re-checked by the
scheduler as a backstop):

- **≤ 10 unique devices** per dispatch.
- **≤ 40 total Device Farm runs**, where `runs = specs × devices`. `specs` is the
  number of shards for the platform when `tests` is empty, or **1** when you pass a
  `tests` filter (a filter collapses the run to a single grepped spec). Single-spec
  addons are always `specs = 1`; `inference-addon-cpp` counts one shard per desktop
  suite (regenerated at validation time), so its fan-out is bounded correctly too.

The full supported matrix fits on every addon today: 3 Android devices and 2 iOS
devices, so the worst cases are `tts-ggml` Android at `9 × 3 = 27` runs and
`llm-llamacpp` iOS at `13 × 2 = 26`. Adding devices beyond the supported set is
what pushes a shard-heavy addon over — `llm-llamacpp` iOS with 3 devices is
`13 × 3 = 39`, and a fourth breaks the cap. If you exceed it, either **add a
`tests` filter** (drops `specs` to 1) or **reduce devices**. Both caps fail fast
and free.

## What changed on PRs

- The `run-mobile-integration-tests` lane was removed from the `on-pr-*`
  workflows so opening/updating a PR no longer launches Device Farm. The
  mobile-only wrapper `on-pr-inference-addon-cpp.yml` had its automatic
  `pull_request_target` trigger disabled instead (it has no other lane); its
  gating machinery is preserved.
- Mobile status was **dropped from the Merge Guard**: it is no longer a required
  (or optional-but-reported) check, so a mobile run can never block a merge.
- The **`run-mobile-addon-tests` label is kept** but no longer starts a standalone
  mobile suite. See [LABELS.md](./LABELS.md).

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
