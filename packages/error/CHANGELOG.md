# Changelog

## [0.2.0]

Release Date: 2026-09-14

📦 **NPM:** https://www.npmjs.com/package/@qvac/error/v/0.2.0

`@qvac/error` 0.2.0 is the first release of the package as TypeScript ESM. The source moved to `src/index.ts`, the published entry is `dist/index.js`, and type declarations are generated instead of hand-written. The error API itself is unchanged.

## Breaking Changes

### ESM-Only Package

The package sets `"type": "module"` and its `exports` map offers only an `import` condition, so CommonJS `require` no longer resolves it. Consumers that are still CommonJS should stay on the 0.1.x line.

**Before:**

```js
const { QvacErrorBase, addCodes } = require('@qvac/error')
```

**After:**

```ts
import { QvacErrorBase, addCodes } from '@qvac/error'
```

### Only the Package Root Is Importable

The package previously exposed `main` with no `exports` map, which left every internal file reachable. It now declares `.` and `./package.json` and nothing else, so deep imports into the package fail.

## Unchanged

The exported names are the same: `QvacErrorBase`, `addCodes`, `getRegisteredCodes`, `isCodeRegistered`, `INTERNAL_ERROR_CODES`, and `QvacErrorBase` as the default export. Error codes, the registry behaviour, and serialization are untouched. Types now ship from `dist/index.d.ts` and describe the same shapes the hand-written `index.d.ts` did.

## [0.1.2] - 2026-04-09

### Changed

#### Package renamed from `@qvac/error-base` to `@qvac/error`

The package has been renamed from `@qvac/error-base` to `@qvac/error` to better reflect its role as the canonical error library for the QVAC ecosystem. All references in the README (title, install command, and require statements) have been updated accordingly.

## [0.1.1]

Initial tracked release.
