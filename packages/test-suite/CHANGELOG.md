# Changelog

## [Unreleased]

### Folded into the qvac monorepo

The framework moved from the standalone `tetherto/qvac-test-suite` repository into
[`tetherto/qvac`](https://github.com/tetherto/qvac) at `packages/test-suite`. It is now a normal SDK-pod
package: same PR gate (`SDK Pod Checks`), same GPR-dev / npm-release publishing, and the same
changelog and release-guard tooling as `@qvac/rag` and `@qvac/logging`.

### Renamed to `@qvac/test-suite`

The package is renamed from `@qvac/qvac-test-suite` to `@qvac/test-suite`, dropping the duplicated scope
word. The GitHub Packages dev build is correspondingly renamed from `@tetherto/qvac-test-suite` to
`@tetherto/test-suite-mono`.

**Migration:** change the dependency specifier and any import specifiers.

```diff
-"@qvac/qvac-test-suite": "^0.10.3"
+"@qvac/test-suite": "^0.11.0"
```

```diff
-import type { TestDefinition } from '@qvac/qvac-test-suite'
+import type { TestDefinition } from '@qvac/test-suite'
```

`@qvac/qvac-test-suite` is deprecated on npm but remains installable, so consumers pinned to a released
`0.10.x` keep working. The framework itself still recognises all four names — `@qvac/test-suite`,
`@tetherto/test-suite-mono`, `@qvac/qvac-test-suite`, `@tetherto/qvac-test-suite` — when resolving the
installed package for mobile scaffolding and when externalising consumer test definitions, so a mixed
setup during migration resolves correctly.

### Testing a framework branch without publishing

`.github/workflows/test-sdk.yml` gains a `test-suite-source` input (`manifest` | `branch` | `npm`) plus
`test-suite-version`, mirroring the existing `inference-source` selector. `branch` builds and packs
`packages/test-suite` from the checked-out ref and installs that tarball into the SDK e2e consumer, so an
SDK change can be tested against an unreleased framework change. PRs that touch `packages/test-suite` run
their e2e suite in `branch` mode automatically.

---

Releases before the fold were cut from `tetherto/qvac-test-suite`; that repository's history and pull
requests remain the record for `0.10.2` and earlier.
