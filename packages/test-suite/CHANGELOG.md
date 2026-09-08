# Changelog

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
