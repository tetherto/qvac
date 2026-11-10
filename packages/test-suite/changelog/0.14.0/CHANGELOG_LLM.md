# QVAC Test Suite v0.14.0 Release Notes

📦 **NPM:** https://www.npmjs.com/package/@qvac/test-suite/v/0.14.0

A step that runs before a consumer leg starts can now ask which tests that leg will execute, and a long list of test ids can be passed to the producer through a file instead of the command line.

---

## New APIs

### Resolve the tests a leg will run with `selectRunTests`

`selectRunTests(catalog, { ...selectionOptions, platform })` returns the tests one consumer leg executes, without starting a producer. It applies the same `suite`, `excludeSuite`, `filter` and `include` rules the producer queues from, leaves out tests skipped on every platform, and drops the tests platform policy skips on that leg. The dropped ids come back in `platformSkippedTestIds`. Use it to prepare a leg ahead of the run, for example to restore only the models it needs from a cache.

```typescript
import { loadConfig, loadTests, selectRunTests } from '@qvac/test-suite'

const config = await loadConfig(configDir)
const { tests, platformSkippedTestIds } = selectRunTests(await loadTests(config, configDir), {
  suite: 'smoke',
  platform: 'desktop-macos'
})
```

`selectTests` (the producer's selection alone), `matchesPlatform`, `getPlatformSkipReason` and the selection types are exported from the Node entry as well. The mobile entry is unchanged.

### Pass test ids from a file with `--include-file`

`run:producer` and the `run:local:*` commands take `--include-file <path>`, a file of test ids one per line, combined with `--include`. A long impacted-test list no longer has to fit on the command line, which on Windows is limited to 8,191 characters. An id the catalog does not contain still fails the run.

```bash
npx qvac-test run:producer --suite=smoke --include-file=include-tests.txt
```

Both additions are additive: existing configurations and commands run exactly as on 0.13.0.
