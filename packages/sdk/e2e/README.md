# SDK Tests

SDK dogfooding tests built on [`@tetherto/qvac-test-suite`](https://github.com/tetherto/qvac-test-suite).
A producer orchestrates a shared queue of tests over MQTT; a consumer runs them on desktop (Node), Electron
(packaged Electron main process), strict Snap, or mobile (Bare + React Native).

## Running locally

```bash
cd packages/sdk/e2e
npm run install:build                # installs deps + builds tests
cp .env.example .env                 # only needed if you want to point at a remote broker

npx qvac-test run:local:desktop
npx qvac-test run:local:electron --filter completion-
npx qvac-test run:local:snap --filter snap-
npx qvac-test run:local:android
npx qvac-test run:local:ios
```

**MQTT broker.** `run:local:*` requires a broker serving WebSockets on port 8080 and MQTT/TCP on 1883.
If nothing is detected on localhost, the command prompts to install `aedes` + `websocket-stream` globally and
keeps an embedded broker alive while tests are running. Bring your own broker if you prefer — just expose
`ws://...:8080` and `mqtt://...:1883`.

**Common flags.** All `run:local:*` commands accept `--filter`, `--suite`, `--exclude-suite`, `--runId`.
Mobile and Electron add `--skip-build` (see below). Run `npx qvac-test run:local:<platform> --help` for the
full list.

**Platform prerequisites.**

- iOS: Xcode + connected device trusted in Xcode. Team ID auto-detected; override with `QVAC_IOS_TEAM_ID`.
- Android: `adb` + USB-debuggable device.
- Desktop: Node 22+.
- Electron: Node 22+, Electron Forge dependencies, and a desktop runner capable of launching packaged Electron
  apps. The config declares `macos`, `windows`, and `linux`; local runs package the current host target unless
  `--platform` / `--arch` are supplied.
- Snap: Linux with Snapcraft, snapd, a working LXD setup, Xvfb or a graphical session, and permission to
  install local snaps with `sudo snap install --dangerous`.

### Rebuilding after changes

Which rebuild command you run depends on what changed.

| You changed                              | Command                      | Rebuild packaged apps?                    |
| ---------------------------------------- | ---------------------------- | ----------------------------------------- |
| SDK source (`packages/sdk/` outside e2e) | `npm run install:build:full` | Yes — `--skip-build` will miss the change |
| Test code or assets in `e2e/`            | `npm run install:build`      | Yes for mobile and Electron               |
| Only the producer side (filter, suite)   | none                         | No — use `--skip-build`                   |

- `install:build` = `npm install --install-links && npm run build`. Picks up changes in this package.
- `install:build:full` = `prepare:sdk` (bun install + bun run build in `packages/sdk/`) + `install:build`.
  Use after any SDK change. If you've already rebuilt the SDK yourself (`cd .. && bun run build`), plain
  `install:build` is enough.
- **Mobile requires a fresh APK/IPA** to pick up either SDK or test-code changes — the baked app bundle
  contains the compiled test executors and the SDK. Omit `--skip-build` to rebuild.
- **Electron requires a fresh Forge package** to pick up SDK, test-code, or `fixtures/qvac.config.electron.json`
  changes. Omit `--skip-build` to rebuild.
- **Snap requires a fresh strict Snap** after SDK, test, Electron package, or `snap/snapcraft.yaml` changes.
- **`--skip-build` is for fast iteration that doesn't touch compiled code**: re-running the same build with
  a different `--filter` or `--suite`, or just re-running to debug flakiness. The producer reads
  definitions fresh each run, so filter / suite changes are picked up without rebuilding.

### Electron local smoke

Electron e2e packages this directory as an Electron Forge app (`forge.config.cjs`), starts the configured
consumer entry from the Electron main process, and uses `@qvac/sdk/electron-forge` to bundle the SDK plugins
declared in `fixtures/qvac.config.electron.json`.

```bash
npm run install:build:full
npx qvac-test run:local:electron --filter completion-
```

The Electron consumer registers the desktop/shared executor set, so standard filters such as `completion-`,
`embedding-`, `translation-`, or `model-` route through the same test definitions used by desktop.

The full Electron pass intentionally skips `diffusion-`, `finetune-`, `delegated-`, `no-lingering-bare-`, and
`vla-` tests. These suites are resource-heavy or depend on process/lifecycle behavior that is not stable inside
the packaged Electron worker model: diffusion and VLA require heavyweight model execution, finetune can monopolize
the worker during long-running operations, delegated inference depends on peer/provider startup semantics, and
no-lingering Bare tests intentionally spawn and terminate standalone Bare workers that conflict with Electron's
packaged worker lock.

`classification-` runs in Electron through the shared Node executor and bundled `@qvac/classification-ggml`
weights; no registry model pre-download is required.

### Strict Snap e2e

The Snap target wraps the Linux Electron package in `snap/snapcraft.yaml` with strict confinement. Test code,
the SDK worker, addons, fixtures, and assets are included under the read-only `$SNAP` mount. Generated config,
models, Corestore state, and worker locks use writable `$SNAP_USER_COMMON`.

Electron is deliberately used as the packaging vehicle because the affected Workbench runtime is Electron and
Electron Forge produces a self-contained application containing the SDK worker and native addons. The desktop
Node consumer runs from the host checkout and depends on the host Node.js installation, so wrapping it would
create an artificial package that does not exercise the production addon-packaging boundary. Snap remains a
separate test-framework consumer for installation, confinement, environment, and refresh behavior, while reusing
the same model/addon test surface and skip policy as the regular Electron consumer.

```bash
npm run install:build:full
npx qvac-test run:local:snap --filter snap-
```

`snap-storage-common-root` verifies that strict Snap rewrites `HOME` to revision-specific
`SNAP_USER_DATA` while the SDK worker creates `.qvac/.worker.lock` under `SNAP_USER_COMMON`. Desktop,
mobile, and non-Snap Electron consumers skip this platform-only test.

CI additionally builds two distinct local Snap artifacts and runs `scripts/run-snap-refresh-test.mjs`.
The first revision records its home/common paths and creates SDK registry Corestore data; the second revision
must have a different revision home while preserving and reopening those SDK-owned files from common storage.
After that preflight, the normal MQTT consumer runs the Electron-supported SDK model and addon tests inside the
installed Snap.

Use `QVAC_TEST_SNAP_SUDO=0` when snap administration does not require `sudo`. Set
`QVAC_TEST_SNAP_KEEP_INSTALLED=1` to preserve the package and common data after refresh diagnostics.

### Custom plugin bundling

[`fixtures/echo-plugin/`](./fixtures/echo-plugin) is a pure-JS custom plugin (no native addon) used to exercise
the SDK plugin system end-to-end: `qvac.config.*` → `bundleSdk` → worker registration → `invokePlugin` /
`invokePluginStream`. It's declared as a `custom-echo-plugin` dependency (`file:./fixtures/echo-plugin`) and
listed in the `plugins` array of `fixtures/qvac.config.e2e.json` and
`fixtures/qvac.config.electron.json`,
the same way a real app would add a third-party or in-repo custom plugin. `PluginExecutor`
([`tests/shared/executors/plugin-executor.ts`](./tests/shared/executors/plugin-executor.ts)) calls the plugin's
own client wrapper (`custom-echo-plugin/client`) for the happy-path tests, mirroring how a real consumer would
use a custom plugin rather than calling `invokePlugin` directly.

Both `qvac.config.*` files list built-in plugins explicitly, not just `custom-echo-plugin/plugin`: an empty
or missing `plugins` array bundles all built-ins by default, but as soon as it's non-empty only the listed
plugins are included (see `resolvePluginSpecifiers` in `@qvac/sdk/commands/bundle`). Omitting the built-ins here
would silently drop LLM/whisper/OCR/etc. plugin registration from the workers. The Electron config intentionally
omits `sdcpp-generation` and `ggml-vla` because those addons are skipped by both the regular Electron and Snap
consumers.

Each platform bundles the worker with the plugin included through its normal build path:

- **Desktop** — `npm run bundle:sdk` (folded into `install:build:full`) calls `bundleSdk` programmatically
  (equivalent to `npx qvac bundle sdk`, without requiring `@qvac/cli` as a dependency) and writes
  `qvac/worker.entry.mjs` at the project root, which is the SDK's standard priority-3 worker resolution path.
- **Electron** — `forge.config.cjs` configures `@qvac/sdk/electron-forge` with
  `configPath: fixtures/qvac.config.electron.json`; the Forge plugin runs `bundleSdk` automatically during
  `electron-forge package`. Snap reuses this packaged Linux application and plugin set.
- **Mobile** — `qvac-test.config.js` sets `consumers.mobile.qvacConfig` to `fixtures/qvac.config.e2e.json`.
  `qvac-test build:consumer:mobile` copies that file into the generated Expo project root as `qvac.config.json`
  before `expo prebuild`, so the SDK's `withMobileBundle` Expo plugin discovers it and bundles the same plugin
  set as desktop.

**Local sequencing:** desktop and Electron share `qvac/worker.entry.mjs` (and `qvac.config.json`) at the project
root. `forge.config.cjs` snapshots whatever's there before Electron overwrites it and restores it in
`postPackage`, so `run:local:desktop` and `run:local:electron` can run in any order without clobbering each
other's bundle.

## Running in CI

### Label-triggered on PRs

See [`.github/workflows/on-pr-test-sdk.yml`](../../../.github/workflows/on-pr-test-sdk.yml).

- `test-e2e-smoke` — runs the `smoke` suite on desktop and mobile consumers.
- `test-e2e-full` — runs the full catalog on desktop and mobile consumers.
- Release-branch PRs with SDK changes auto-run the same desktop and mobile suite.
- Success applies the `e2e-tested` label.

### Manual runs

Open [Actions → QVAC Tests (sdk) → Run workflow](https://github.com/tetherto/qvac/actions/workflows/test-sdk.yml)
and submit the form.

Snap runs are manual-only. Select `snap` to run only the strict Snap consumer, or `all` to include it with
the other manually selected consumers.

Non-obvious inputs:

- **"Use workflow from" (GitHub's own selector) vs `test-version`** — these are independent. The selector
  picks the branch that supplies the _workflow YAML_; `test-version` is the git ref that gets checked out for
  the _code under test_ (and the e2e package). Leave `test-version` blank to test the same branch the
  workflow was loaded from. Set it to test workflow edits from one branch against SDK code on another.
- `suite` + `suite-custom` — pick `custom` to pass arbitrary comma-separated suite tags via `suite-custom`.
- `desktop-platforms` — JSON array of runner labels; defaults to all three GPU runners. Narrow to one during
  debugging.

The remaining inputs (`targets`, `filter`, `exclude-suite`, timeouts, `cache-models`) are self-explanatory in
the form.

## Developing new tests

- **Definitions** live in [`tests/<feature>-tests.ts`](./tests), aggregated in
  [`tests/test-definitions.ts`](./tests/test-definitions.ts). Each entry is a `TestDefinition` with `testId`,
  `params`, `expectation`, optional `suites`, and `metadata`.
- **Executors — pick one of three locations based on runtime requirements:**
  - [`tests/shared/executors/`](./tests/shared/executors) — **default**. Pure SDK API calls, no Node stdlib,
    no RN APIs. Runs on both desktop and mobile. Example:
    [`completion-executor.ts`](./tests/shared/executors/completion-executor.ts).
  - [`tests/shared/executors/node/`](./tests/shared/executors/node) — needs `node:fs`, `node:path`, `process.cwd()`,
    or other Node-only APIs. Example: [`rag-executor.ts`](./tests/shared/executors/node/rag-executor.ts) reads
    documents from disk.
  - [`tests/mobile/executors/`](./tests/mobile/executors) — needs React Native-specific asset loading
    (`Platform`, bundled assets). Example:
    [`mobile/executors/ocr-executor.ts`](./tests/mobile/executors/ocr-executor.ts).
- Register new executors in [`tests/desktop/consumer.ts`](./tests/desktop/consumer.ts),
  [`tests/mobile/consumer.ts`](./tests/mobile/consumer.ts), and/or reuse those executors from
  [`tests/electron/consumer.ts`](./tests/electron/consumer.ts) as applicable. Mobile platform skips go through
  `SkipExecutor` at the top of the mobile consumer (first match wins).
- **Smoke suite policy.** If a new feature introduces core functionality that has no existing smoke coverage,
  tag **1-2** tests with `suites: ["smoke"]` — preferring the most representative, fastest, least-flaky test.
  Verify it passes predictably on both desktop and mobile before tagging. Smoke must stay focused and fast; do
  not tag additional tests for a feature that is already covered.
- Assets go under [`assets/`](./assets). Update [`qvac-test.config.js`](./qvac-test.config.js)
  `consumers.mobile.assets.patterns` if the new files aren't covered by existing globs.
- One-time setup (model pre-download, warmup) goes in the exported `bootstrap()` function of each consumer
  entry.

## Troubleshooting

- **No device detected** — `adb devices` (Android) or `xcrun devicectl list devices` (iOS). USB
  trust/debugging must be enabled.
- **Electron packaged app missing** — rerun without `--skip-build`, or pass the exact host target:
  `npx qvac-test run:local:electron --platform macos --arch arm64 --filter completion-`.
- **iOS signing errors** — open [`build/consumers/ios/ios/QVACTestConsumer.xcworkspace`](./) in Xcode once and
  set the Team under Signing & Capabilities, or export `QVAC_IOS_TEAM_ID`. If Xcode keeps failing, change
  `QVAC_IOS_BUNDLE_ID` to a suffix unique to your Apple account.
- **MQTT broker unreachable** — the embedded broker needs `aedes` + `websocket-stream`. `run:local:*` offers
  to install them globally; accept, or run `npm install -g aedes websocket-stream` yourself.
- **Manual iOS build fallback** — when the automated flow fails, build from the generated Xcode workspace
  manually:

  ```bash
  npx qvac-test build:consumer:ios --runId <run-id> --config .
  cd build/consumers/ios/ios
  xcodebuild \
    -workspace QVACTestConsumer.xcworkspace \
    -scheme QVACTestConsumer \
    -configuration Release \
    -destination 'id=<device-udid>'
  ios-deploy --bundle ~/Library/Developer/Xcode/DerivedData/<derived-data-dir>/Build/Products/Release-iphoneos/QVACTestConsumer.app
  npx qvac-test run:producer --runId <run-id> --config .
  ```
