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

Add each numeric map's owner, file, and symbols to `sources`. Maps must use static
literals, constant references, or `Object.freeze`; unsupported expressions fail
validation. The checker reads source without loading packages or native addons
and ignores compiled JavaScript copies of listed TypeScript modules.

Run `npm run errors:check`, `npm run errors:test`, and `npm run errors:typecheck`
from the repository root. Merge Guard requires successful validation for
authorized PRs into `main`. Release, feature, and temporary branch PRs run the
workflow directly for package and plugin changes. Runtime `addCodes` checks
individual duplicates; it does not enforce reservations.

## External repository validation

Add a test using the package's actual numeric map:

```javascript
import registry from '@qvac/error/code-ranges.json' with { type: 'json' }
import { validatePackageCodes } from '@qvac/error/code-ranges'
import { ERR_CODES } from './src/errors.js'

validatePackageCodes(registry, '@qvac/core', ERR_CODES)
```

The validator rejects unallocated or retired owners, out-of-range codes, duplicate
numbers, and alias drift. It runs under Node or Bare without importing the error
runtime. External CI must invoke it; monorepo CI cannot inspect external source.

The shipped JSON is a release snapshot. If it predates a new reservation, pass the
reviewed registry from that reservation's commit instead. Always consult the
latest registry on this repository's `main` branch when selecting new ranges.
