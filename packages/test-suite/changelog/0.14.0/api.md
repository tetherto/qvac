# 🔌 API Changes v0.14.0

## Export selectRunTests to resolve a leg's tests before the run

PR: [#5595](https://github.com/tetherto/qvac/pull/5595)

```typescript
import { loadConfig, loadTests, selectRunTests } from '@qvac/test-suite'

const config = await loadConfig(configDir)
const { tests, platformSkippedTestIds } = selectRunTests(await loadTests(config, configDir), {
  suite: 'smoke',
  platform: 'desktop-macos'
})
```

---

## Read included test ids from a file with `--include-file`

PR: [#5608](https://github.com/tetherto/qvac/pull/5608)

`run:producer` and the `run:local:*` commands take `--include-file <path>`, a file of test ids one per line. The ids are combined with `--include`, and an id the catalog does not contain still fails the run.

```bash
npx qvac-test run:producer --suite=smoke --include-file=include-tests.txt
```

---

