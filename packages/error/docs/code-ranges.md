# Error code allocation maintenance

[`code-ranges.json`](../code-ranges.json) is the canonical registry. Each allocation
has an `owner`, inclusive `[start, end]` pairs in `ranges`, and a `status`:
`reserved` before adoption, `active` in use, or `retired` when no longer used.
Keep retired entries. Check earlier records before claiming historical gaps;
prefer new blocks after the highest allocation in the appropriate band.

`formerOwners` records history without granting registration rights. `sharedWith`
permits confirmed compatibility families; per-code `aliases` preserves existing
name differences at their original numbers. Keep conflict explanations beside
their allocations. These fields do not authorize unrelated errors sharing a code.

## Monorepo validation

Add each numeric map's owner, file, and symbols to
[`sources.ts`](../../../scripts/error-codes/sources.ts). Keep maps at module scope,
using static literals, constant references, or `Object.freeze`.
Keep registration definitions static too; filter them with
`Object.fromEntries(Object.entries(definitions).filter(...))` instead of mutating
a map. Shadowed maps, mutations, and passing checked maps to unsupported helpers
fail validation. The checker reads source without loading packages or native
addons and ignores compiled JavaScript copies of listed TypeScript modules.
Discovery is file-local and does not follow imports, so list maps registered
through imported helpers explicitly in `sources`.

The CLI scans production JavaScript and TypeScript modules under `packages/` and
`plugins/`, including `.cjs`, `.mts`, and `.cts`. Declarations, tests, examples,
benchmarks, docs, scripts, dependencies, and build outputs are excluded.

Run `npm run errors:check`, `npm run errors:test`, and `npm run errors:typecheck`
from the repository root. Merge Guard requires successful validation for
authorized PRs into `main`. Release, feature, and temporary branch PRs run the
workflow directly for package and plugin changes. Runtime `addCodes` checks
individual duplicates; it does not enforce reservations.

## External repository validation

Add a test using the package's actual numeric map. For named `{ code, message }`
definitions, project their codes without duplicating the definitions:

```javascript
import registry from '@qvac/error/code-ranges.json' with { type: 'json' }
import { validatePackageCodes } from '@qvac/error/code-ranges'
import { ERROR_DEFINITIONS } from './src/errors.js'

const codes = Object.fromEntries(
  Object.entries(ERROR_DEFINITIONS).map(([name, { code }]) => [name, code])
)
validatePackageCodes(registry, '@qvac/core', codes)
```

If the package already exports a name-to-number map, pass it directly.

The validator rejects unallocated or retired owners, out-of-range codes, duplicate
numbers, and alias drift. It runs under Node or Bare without importing the error
runtime. External CI must invoke it; monorepo CI cannot inspect external source.

Install a release that provides `validatePackageCodes`. Its bundled JSON is a
release snapshot; later reservations can be used independently of another
package release. Pin the full SHA of a reviewed, merged reservation commit in
external CI and fetch its registry on each run:

```sh
curl --fail --silent --show-error --location \
  'https://raw.githubusercontent.com/tetherto/qvac/<commit-sha>/packages/error/code-ranges.json' \
  --output code-ranges.json
```

Parse the downloaded file as JSON and pass it as `registry` above. Keep the pin
in CI configuration rather than maintaining a copied registry. Advance it when
your allocation changes; unrelated reservations do not require a refresh. Use
the bundled JSON again once a dependency update includes your allocation.
Always consult current `main` when selecting new ranges.
