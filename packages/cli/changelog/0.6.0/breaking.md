# 💥 Breaking Changes v0.6.0

## Migrate SDK TTS from onnx-tts to tts-ggml

PR: [#2244](https://github.com/tetherto/qvac/pull/2244)

Plugin import path: `@qvac/sdk/onnx-tts/plugin` → `@qvac/sdk/tts-ggml/plugin` (compat alias retained temporarily). This affects CLI bundles that reference the plugin path; the CLI itself does not expose `loadModel`.

---

## Rewrite CLI bundle/verify as thin wrappers around @qvac/sdk/commands

PR: [#2261](https://github.com/tetherto/qvac/pull/2261)

**BEFORE:**

```json
{
  "devDependencies": {
    "@qvac/sdk": "^0.11.0"
  }
}
```

```typescript
// serve/core/sdk.ts — runtime floor
const MIN_SDK_VERSION = '0.11.0'
const sdkVersion = await resolveSDKVersion()
if (sdkVersion && !satisfiesMinVersion(sdkVersion, MIN_SDK_VERSION)) {
  throw new Error(`@qvac/sdk ${sdkVersion} is too old...`)
}
```

**AFTER:**

```json
{
  "dependencies": {
    "@qvac/sdk": "^0.12.0"
  }
}
```

```typescript
// bundle-sdk/index.ts — delegates to SDK commands
export { bundleSdk } from '@qvac/sdk/commands'
export type { BundleSdkOptions, BundleSdkResult } from '@qvac/sdk/commands'
```

Installing `@qvac/cli` always pulls in `@qvac/sdk`. SDK compatibility is enforced by the dep range, not a runtime semver check in `qvac serve openai`.

---

## Delete CLI SDK wrapper layer, use static @qvac/sdk imports in serve

PR: [#2267](https://github.com/tetherto/qvac/pull/2267)

**BEFORE:**

```typescript
type ResolvedModelEntry = {
  src: string // registry:// URL constructed by CLI
  // ...
}
```

**AFTER:**

```typescript
type ResolvedModelEntry = {
  modelSrc: string | ModelConstant // SDK extracts registry:// URL
  // ...
}
```

---

## Rewrite serve HTTP layer on Fastify + Zod

PR: [#2306](https://github.com/tetherto/qvac/pull/2306)

Only the **order of validation** changed: image routes (`/v1/images/generations`, `/v1/images/edits`) now resolve the model before running per-parameter checks (`response_format`, `output_format`, `output_compression`, `background`). Previously those parameter checks ran first, so a request naming an unknown model could be rejected on a parameter before any model lookup. The error codes themselves are unchanged — a request that names an unknown model now surfaces `404 model_not_found` instead of a parameter error.

**BEFORE:**

```sh
$ curl -sX POST .../v1/images/generations \
    -H 'Content-Type: application/json' \
    -d '{"model":"unknown","prompt":"hi","output_format":"jpeg"}'

400 { "error": { "code": "unsupported_output_format", ... } }
```

**AFTER:**

```sh
$ curl -sX POST .../v1/images/generations \
    -H 'Content-Type: application/json' \
    -d '{"model":"unknown","prompt":"hi","output_format":"jpeg"}'

404 { "error": { "code": "model_not_found", ... } }
```

---
