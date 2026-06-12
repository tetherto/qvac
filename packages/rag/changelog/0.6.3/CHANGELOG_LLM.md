# QVAC RAG v0.6.3 Release Notes

📦 **NPM:** https://www.npmjs.com/package/@qvac/rag/v/0.6.3

This patch bumps the production `bare-fetch` dependency across the 2→3 major to `^3.0.1`.

---

## 🔧 Changed

### `bare-fetch` bumped to `^3.0.1`

The 2→3 transition is transitive-only — the public fetch API is unchanged. The only behavioral change in 3.x is the header validation added in 3.0.1, and RAG only constructs RFC-valid headers, so no code change is required. The bare-tls trust-store change already shipped within the 2.x line via `bun.lock`.
