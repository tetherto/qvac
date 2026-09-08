# QVAC RAG v0.6.4 Release Notes

📦 **NPM:** https://www.npmjs.com/package/@qvac/rag/v/0.6.4

This patch drops the unused `crypto-browserify` hard dependency. The package never imported it.

## Changed

### Unused `crypto-browserify` dependency removed

`#crypto` still resolves to `bare-crypto` on Bare, `node:crypto` on Node, and `globalThis.crypto` on browser / React Native. Consumers that need Node-style `crypto.createHash` (for example HyperDB document hashing in a browser or React Native runtime) should install `crypto-browserify` themselves and assign it to `globalThis.crypto`, as documented in the README.
