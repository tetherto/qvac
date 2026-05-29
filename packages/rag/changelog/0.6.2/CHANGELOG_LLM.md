# QVAC RAG v0.6.2 Release Notes

📦 **NPM:** https://www.npmjs.com/package/@qvac/rag/v/0.6.2

This patch fixes a package exports gap that broke SDK consumer installs when TypeScript compiled `@qvac/rag/errors` imports to `@qvac/rag/errors.js`.

---

## 🔌 API

### `./errors.js` export alias

TypeScript ESM output appends `.js` to subpath imports. Node enforces `package.json#exports` strictly, so `@qvac/rag/errors.js` failed even though `@qvac/rag/errors` worked. This release adds a matching `./errors.js` export entry pointing at the same module as `./errors`.

No API surface change — existing `@qvac/rag/errors` imports continue to work unchanged.
