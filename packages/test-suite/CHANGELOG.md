# Changelog

## [0.11.3]

📦 **NPM:** https://www.npmjs.com/package/@qvac/test-suite/v/0.11.3

Mobile consumer builds are fixed. Building for one platform no longer fails on the other platform's binaries, and split native addons now arrive with the binary they need instead of silently shipping without it.

---

## Bug Fixes

### Mobile builds only look at the platform being built

`withMobileBundle` passed the combined Android and iOS host list to both the bundler and the verifier, so an Android prebuild failed when iOS binaries were absent, and an iOS prebuild failed the same way in reverse. Each step now selects the hosts for the platform it is building: `android-arm64` for Android, and `ios-arm64` plus the two simulator hosts for iOS.

Only verification is scoped this way. The worker bundle is a single artifact both platforms import, so it is still built for every mobile host — building it per platform made a dual-platform `expo prebuild` overwrite the first platform's bundle with the second's.

### Split native addons ship their binary again

Mobile consumer manifests declared only the meta addon packages, which ship JavaScript and no binaries. Since those addons were split per platform, the actual binaries live in cross-built packages that no install host ever matches, so neither `os`/`cpu`-filtered `optionalDependencies` nor the package manager running on the build host could ever select them. Every mobile consumer therefore installed the addon without its binary and failed bundle verification.

The generator now reads the installed tree for packages that route their native binding through a `#host-addon` imports map, resolves the package that map names for the platform being built, and declares it directly — an Android build gets `@qvac/<addon>-android-arm64`, an iOS build gets `@qvac/<addon>-ios`, and neither downloads the other's binaries. Reading each addon's own imports map rather than a hardcoded roster keeps the selection in step with the publish-time slicer and skips pre-split versions, which carry no such map. The addon and its prebuild package are pinned to the same exact version.

A related gap closed with it: `bare-link` emits a binary only for a package marked `addon: true` and reads it from that package's own `prebuilds/` directory. After the split, the meta package kept the marker but shipped no prebuilds, so verification passed while the linker emitted nothing and a clean build shipped no native addon at all. The linker now resolves each addon's platform package through the same imports map and links that directory directly, keeping the emitted library's pre-split name.

Three cases are deliberately left untouched: an addon the consumer pins itself — to a range, a `file:` path, or a different version — an addon that already ships a local `prebuilds/` directory for the target, and a pre-split addon version. Source builds keep taking precedence.

## [0.11.2]

📦 **NPM:** https://www.npmjs.com/package/@qvac/test-suite/v/0.11.2

One new selection option. `run:producer` can now add named tests on top of whatever a suite already selected — a combination the existing options could not express.

---

## New APIs

### Add specific tests on top of a suite with `--include`

`--suite`, `--exclude-suite` and `--filter` all compose with AND: each one narrows what the previous left. That makes "run this suite, plus these particular tests" impossible to ask for. `--suite=smoke --filter=parakeet` returns the intersection — the handful of parakeet tests that happen to be tagged smoke — when what was wanted was the union.

`--include` takes a comma-separated list of test ids and unions them back in after the other options have had their say:

```bash
# Before — the intersection, a few tests at best and often none.
qvac-test run:producer --suite=smoke --filter=parakeet

# After — the whole smoke suite plus these three, whatever their tags.
qvac-test run:producer --suite=smoke \
  --include=parakeet-tdt-mp3,parakeet-ctc-wav,parakeet-unified-mp3
```

Three behaviours are worth knowing.

It matches **exact ids, not prefixes**. This is the opposite of `--filter`, where `model-load-llm` also drags in `model-load-llm-load-mode-none`. With `--include` an id selects that test and nothing else, so adding one case to a suite run cannot quietly pull in its neighbours.

An id that matches nothing **fails the run**. Naming a test and then getting a green run that never executed it is the opposite of what was meant, so the mistake surfaces immediately instead of being silently dropped.

An empty value is a **no-op**. Callers — CI templates in particular — can pass the flag unconditionally without special-casing the empty case.

`run:local:*` forwards the option too, so the same selection works when driving a run locally.

Internally the selection rules moved out of the producer command into a pure `selectTests()` helper, so suite, exclude, filter and include compose in one place rather than being spread across the command.

## [0.11.1]

📦 **NPM:** https://www.npmjs.com/package/@qvac/test-suite/v/0.11.1

A single fix: memory samples now appear in e2e reports on Windows. Desktop and Electron runs on Windows previously produced reports with no memory data at all, and did so silently.

---

## Bug Fixes

### Memory sampling works on Windows

The memory poller collected resident set size by shelling out to `ps`, which does not exist on Windows. Desktop and Electron consumers on Windows therefore reported no memory at all — and because the collector failed quietly rather than erroring, the gap looked like a suite that simply had nothing to report.

Windows now has its own collector. It keeps a single PowerShell process alive and queries `Win32_Process` through CIM for process ids, parent ids and working-set bytes, so a whole test run costs one process start rather than one per sample. That matters at the polling rate involved: starting PowerShell per sample would have added enough overhead to distort the very numbers being measured.

The collector reuses the existing process-tree aggregation, so a sample covers the consumer together with its Bare workers, and excludes the PowerShell collector itself from the total. Windows polls every 500 ms.

Nothing changes for existing consumers. The POSIX path is untouched, the emitted `qvac/app-memory` payload keeps the same shape, and reports produced on macOS and Linux are byte-for-byte what they were before. Collector startup and any failure are now logged, so a future gap surfaces as a log line instead of an empty section.

Process exits, stream failures, collector restarts and shutdown are all handled without leaking a PowerShell process or stalling the consumer, and outstanding snapshot requests are bounded.

## [0.11.0]

📦 **NPM:** https://www.npmjs.com/package/@qvac/test-suite/v/0.11.0

First release of the distributed test-orchestration framework from the QVAC monorepo. The package moved out of the standalone `tetherto/qvac-test-suite` repository into `packages/test-suite`, and is renamed to `@qvac/test-suite`. The runtime API is unchanged from `0.10.2` — only the package name and its home moved.

The point of the move: the framework and the e2e suites that use it can now change in a single pull request, and CI can run the SDK's full e2e suite against an unreleased framework build. Previously every framework change needed a publish → version bump → reinstall round-trip across two repositories.

---

## 🔌 API

### Renamed to `@qvac/test-suite`

The duplicated scope word is gone. The GitHub Packages dev build is renamed alongside it.

| | Before | After |
| --- | --- | --- |
| public npm | `@qvac/qvac-test-suite` | `@qvac/test-suite` |
| GitHub Packages | `@tetherto/qvac-test-suite` | `@tetherto/test-suite-mono` |

**Migration** — update the dependency and any import specifiers:

```diff
-"@qvac/qvac-test-suite": "^0.10.3"
+"@qvac/test-suite": "^0.11.0"
```

```diff
-import type { TestDefinition } from '@qvac/qvac-test-suite'
-import { createExecutor } from '@qvac/qvac-test-suite/mobile'
+import type { TestDefinition } from '@qvac/test-suite'
+import { createExecutor } from '@qvac/test-suite/mobile'
```

React Native consumers that redirect the bare specifier to the `/mobile` entry point in `metro.config.js` need the same rename there.

`@qvac/qvac-test-suite` is deprecated on npm but stays installable — anything pinned to a released `0.10.x` keeps resolving. Nothing is unpublished.

The framework itself recognises all four names when it resolves the installed package for mobile scaffolding and when it externalises consumer test definitions, so a partially migrated setup resolves correctly.

## ⚙️ Infrastructure

### Folded into the monorepo

`packages/test-suite` is now a first-class SDK-pod package: the same `SDK Pod Checks` gate on every PR, the same release guard, the same GPR-dev / npm-release publishing, and the same changelog tooling as `@qvac/rag` and `@qvac/logging`. The directory name equals the release slug, so release branches are `release-test-suite-<x.y.z>` with no path overrides.

### Publishing ships prebuilt output

The package ships only compiled output and deliberately has no `prepare` script, so `npm publish` never builds anything on its own. `dist` is compiled once in a dedicated build job, uploaded, and downloaded by every publish job, which publishes with `NPM_CONFIG_IGNORE_SCRIPTS=true`. This matches how the standalone repository published before the fold, and prevents a publish job with no `node_modules` from shipping a tarball without the CLI or runtime.

## 🧹 Chores

Framework documentation and agent rules were ported into the monorepo's conventions. Two long-standing inaccuracies were corrected while porting: the documented export surface was missing `testReloadSchema`, `startNodeMemoryPoller` and `startDesktopMemoryPoller`, and the architecture notes described a `{repo}-{branch}-{commit}-{timestamp}` run ID that the code never produced — run IDs are timestamp-based per entry point.
