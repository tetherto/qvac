# Changelog

## [0.2.0]

Release Date: 2026-09-14

📦 **NPM:** https://www.npmjs.com/package/@qvac/logging/v/0.2.0

`@qvac/logging` 0.2.0 is the first release of the package as TypeScript ESM. The source moved to `src/`, the published entry is `dist/index.js`, and type declarations are generated instead of hand-written. `QvacLogger` and the `./constants` subpath behave as before.

## Breaking Changes

### ESM-Only Package

The package sets `"type": "module"` and its `exports` map offers only an `import` condition, so CommonJS `require` no longer resolves it. Consumers that are still CommonJS should stay on the 0.1.x line.

**Before:**

```js
const QvacLogger = require('@qvac/logging')
const { LOG_LEVELS } = require('@qvac/logging/constants')
```

**After:**

```ts
import QvacLogger from '@qvac/logging'
import { LOG_LEVELS } from '@qvac/logging/constants'
```

## Unchanged

`QvacLogger` is still the default export and its API is the same: wrap any logger, set the level on the wrapper, and read `QVAC_LOG_LEVEL` from the environment. `./constants` still exports `LOG_LEVELS`, `LEVEL_PRIORITIES`, `DEFAULT_LEVEL` and `ENV_LOG_LEVEL`, and the `LogLevel` type now ships from the package root. Environment access is still delegated to `bare-env` on Bare and a small shim elsewhere, which is now wired through the `#env` import key and a declared `bare-env` dependency.

## [0.1.1]

Release Date: 2026-06-16

📦 **NPM:** https://www.npmjs.com/package/@qvac/logging/v/0.1.1

This release simplifies how `@qvac/logging` reads environment variables across Node.js and Bare runtimes. Log level detection from `QVAC_LOG_LEVEL` (and the Expo-prefixed variant) now routes through a dedicated `./env` module resolved via package import maps instead of inline runtime branching.

## Bare Runtime Compatibility

Environment access is delegated to `bare-env` on Bare via the package `"imports"` map, while Node.js continues to use a small `env.js` shim over `process.env`. This removes the previous try/catch chain over `process`, `bare-process`, and empty fallbacks from the main logger implementation.

```json
// packages/logging/package.json (excerpt)
"imports": {
  "./env": {
    "bare": "bare-env",
    "default": "./env.js"
  }
}
```

The public `QvacLogger` API is unchanged — wrap any logger, set levels on the wrapper, and read `QVAC_LOG_LEVEL` from the environment as before. Consumers do not need to change how they construct or pass loggers into the SDK.
