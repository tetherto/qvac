# QVAC SDK v0.12.2 Release Notes

📦 **NPM:** https://www.npmjs.com/package/@qvac/sdk/v/0.12.2

This patch release unblocks React Native and BareKit apps that bundle `@qvac/sdk` or `@qvac/bare-sdk`. Metro and Bare static analysis no longer reject the config loader, and clients can import the model registry through a dedicated subpath without pulling the full SDK graph into the bundle.

## New APIs

### `@qvac/sdk/models` and `@qvac/bare-sdk/models` subpaths

React Native apps that only need model constant names previously had to import from the package root, which dragged server-side modules into Metro. v0.12.2 adds a `./models` export on both `@qvac/sdk` and `@qvac/bare-sdk` so you can depend on the registry alone.

```typescript
import { LLAMA_3_2_1B_INST_Q4_0 } from "@qvac/sdk/models";
// or on Bare-only clients:
import { LLAMA_3_2_1B_INST_Q4_0 } from "@qvac/bare-sdk/models";
```

## Bug Fixes

### Bare config loader works under Metro static analysis

BareKit and Expo consumers could fail at bundle time with errors such as `Invalid call: import(filePath)` when the SDK resolved `qvac.config.js`. The Bare config loader used dynamic `import()` with a runtime path, which Metro and Bare reject because the target is not a string literal.

v0.12.2 loads `.js` and `.json` config files with `require(filePath)` instead, which satisfies static analysis while keeping the same resolution order (`QVAC_CONFIG_PATH`, then project-root `qvac.config.js` / `qvac.config.json`, then defaults). Supported extensions are centralized in `SUPPORTED_CONFIG_FILE_EXTS` so discovery and validation stay aligned. TypeScript config files (`.ts`) are explicitly rejected on the Bare path with a clear error — use `.js` or `.json` in RN/Bare projects.
