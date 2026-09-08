# QVAC RAG v0.7.0 Release Notes

📦 **NPM:** https://www.npmjs.com/package/@qvac/rag/v/0.7.0

`@qvac/rag` is now TypeScript compiled to ESM. CommonJS `require('@qvac/rag')` no longer works — switch to `import`. Invalid `search` and `infer` queries throw `QvacErrorRAG` with `INVALID_INPUT` instead of a raw `TypeError`. Named exports are unchanged.

## Breaking Changes

### ESM only

The package is `"type": "module"`. Node rejects `require()` of ESM. Use `import`. Named exports (`RAG`, `HyperDBAdapter`, adapters, `ERR_CODES`, `QvacErrorRAG`) are the same. `@qvac/rag/errors` still exports the error class and codes without loading the full package.

**Before:**

```js
const { RAG, HyperDBAdapter } = require('@qvac/rag')
```

**After:**

```ts
import { RAG, HyperDBAdapter } from '@qvac/rag'
```

The 0.6.1 Pear/CJS `require()` path for hard dependencies is gone with this conversion. Pear consumers need an ESM-capable loader.

## Bug Fixes

### Query validated before logging

`rag.search()` and `rag.infer()` reject a non-string or blank query with `QvacErrorRAG { code: INVALID_INPUT }` before any debug log reads `query.substring`. Valid queries are unchanged. Previously a non-string hit `TypeError` at the log line and never reached the existing search guard.
