# QVAC Logging v0.1.1 Release Notes

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
