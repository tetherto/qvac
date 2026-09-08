# Changelog v0.6.4

Release Date: 2026-06-15

## 🔧 Changed

- Drop the unused `crypto-browserify` hard dependency. The package never imported it — `#crypto` resolves to `bare-crypto` (Bare) or `node:crypto` (Node), and the browser / React Native shim reads `globalThis.crypto`. Consumers needing Node-style `crypto.createHash` (e.g. HyperDB document hashing in a browser/RN runtime) should install `crypto-browserify` themselves and assign it to `globalThis.crypto`, as documented in the README.
