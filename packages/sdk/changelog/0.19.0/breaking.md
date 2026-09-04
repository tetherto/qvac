# 💥 Breaking Changes v0.19.0

## Use @qvac/inference for SDK

PR: [#3595](https://github.com/tetherto/qvac/pull/3595)

**BEFORE:**
```typescript
import { … } from '@qvac/sdk/worker-core'
const worker = '<sdk_root>/dist/server/worker.js'
```

**AFTER:**
```typescript
import { … } from '@qvac/sdk/worker-lifecycle'
const worker = '<sdk_root>/dist/src/worker/index.js'
```

`@qvac/bare-sdk` is a thin `@qvac/inference` re-export — `./commands` and `./worker-core` are gone; importing either throws with migration guidance. `./onnx-tts/plugin` is retained as an alias.

**BEFORE:**

```typescript
import { … } from '@qvac/bare-sdk/commands'
import { … } from '@qvac/bare-sdk/worker-core'
import { … } from '@qvac/bare-sdk/onnx-tts/plugin'
```

**AFTER:**

```typescript
// bundling lives in @qvac/sdk; register plugins via @qvac/inference directly
import { … } from '@qvac/bare-sdk/onnx-tts/plugin' // alias → @qvac/inference/tts-ggml/plugin
```

---

## Remove langdetect-text-cld2 from the monorepo

PR: [#4011](https://github.com/tetherto/qvac/pull/4011)

**BEFORE:**
```typescript
import { detectOne, getLangName } from '@qvac/langdetect-text-cld2'

const lang = await detectOne('This is a sample text.')
```

**AFTER:**
```typescript
import { detectOne, getLangName } from '@qvac/langdetect-text'

const lang = detectOne('This is a sample text.')
```

---

## Remove DHT delegated inference

PR: [#4042](https://github.com/tetherto/qvac/pull/4042)

**BEFORE:**
```typescript
await startQVACProvider({ firewall })
const id = await loadModel({ modelSrc, delegate: { providerPublicKey } })
await heartbeat({ delegate: { providerPublicKey } })
await stopQVACProvider()
```

**AFTER:**
```typescript
// Provider mode and delegation are removed. Models load and run locally.
const id = await loadModel({ modelSrc })
await heartbeat()
```

- Removed: `startQVACProvider`, `stopQVACProvider`, `loadModel(...).delegate`, `heartbeat(...).delegate`.
- `unloadModel` response no longer includes `hasActiveProviders`; `getLoadedModelInfo` no longer returns `isDelegated`/`providerInfo`.
- Profiler resource gauges drop the `origin` field (it only ever reported `'local'`), and the per-call `resourceOrigin` profiling option is removed — `ProfilerResourceGauge` (re-exported from `@qvac/sdk`) no longer carries `origin`.
- Removed error classes/codes: `ProviderStartFailedError`, `ProviderStopFailedError`, `ModelIsDelegatedError`, `DelegateNoFinalResponseError`, `DelegateConnectionFailedError`, `DelegateProviderError`.
- Python: `load_model(delegate=...)` removed.

---

## Adopt fabric b10297 consumers and replace no_mmap with load_mode

PR: [#4078](https://github.com/tetherto/qvac/pull/4078)

**BEFORE:**
```typescript
await loadModel({
  modelSrc: MODEL,
  modelType: 'llm',
  modelConfig: { ctx_size: 2048, no_mmap: true }
})
```

**AFTER:**
```typescript
await loadModel({
  modelSrc: MODEL,
  modelType: 'llm',
  modelConfig: { ctx_size: 2048, load_mode: 'none' }
})
```

Full mapping — do not mechanically rename the key and keep a boolean value:

| Before | After |
| --- | --- |
| `no_mmap: true` | `load_mode: 'none'` |
| `no_mmap: false` | omit `load_mode`, or `load_mode: 'mmap'` |
| omitted | omitted (addon default `mmap`) |
| any other value | validation error |

The same mapping applies to `deviceDefaults.llm` and `deviceDefaults['llamacpp-completion']` in a config file.

`load_mode` also reaches modes `no_mmap` never could: `'mlock'`, `'mmap+mlock'` and `'dio'`.

---

## Move SDK e2e onto the published @qvac/test-suite

PR: [#4083](https://github.com/tetherto/qvac/pull/4083)

**BEFORE:**
```ts
import type { TestDefinition } from '@qvac/qvac-test-suite'
import { createExecutor, SkipExecutor } from '@qvac/qvac-test-suite/mobile'
```

**AFTER:**
```ts
import type { TestDefinition } from '@qvac/test-suite'
import { createExecutor, SkipExecutor } from '@qvac/test-suite/mobile'
```

Dependency:

BEFORE:

```json
{ "dependencies": { "@qvac/qvac-test-suite": "^0.10.3" } }
```

AFTER:

```json
{ "dependencies": { "@qvac/test-suite": "^0.11.0" } }
```

Metro resolution for React Native consumers changes with it:

BEFORE:

```js
if (moduleName === '@qvac/qvac-test-suite') {
  return context.resolveRequest(context, '@qvac/qvac-test-suite/mobile', platform)
}
```

AFTER:

```js
if (moduleName === '@qvac/test-suite') {
  return context.resolveRequest(context, '@qvac/test-suite/mobile', platform)
}
```

The old package stays installable and will be deprecated, not unpublished, so anything pinned to a released `0.10.x` keeps resolving. The framework also still recognises all four names at runtime, so a mixed setup during migration resolves correctly.

---

## Add MiniMax music generation support

PR: [#4105](https://github.com/tetherto/qvac/pull/4105)

**BEFORE:**
```python
from tetherto.qvac_sdk import (
    LoadModelSrcRequestAudiogenGgmlModelConfig,
    LoadModelSrcRequestAudiogenGgmlModelConfigLmModelSrc,
)
```

**AFTER:**
```python
from tetherto.qvac_sdk import (
    LoadModelSrcRequestAudiogenGgmlModelConfigAcestep,
    LoadModelSrcRequestAudiogenGgmlModelConfigAcestepLmModelSrc,
    LoadModelSrcRequestAudiogenGgmlModelConfigMinimax,
    LoadModelSrcRequestAudiogenGgmlModelConfigMinimaxLmModelSrc,
)
```

The corresponding `TextEnc`, `Dit`, `Vae`, and `*Addon` generated class names receive the same `Acestep` infix.

---

## Drop n_discarded from the SDK config schema

PR: [#4163](https://github.com/tetherto/qvac/pull/4163)

**BEFORE:**
```typescript
await loadModel({
  modelSrc: MODEL,
  modelType: 'llm',
  modelConfig: { ctx_size: 2048, n_discarded: 256 }
})
```

**AFTER:**
```typescript
await loadModel({
  modelSrc: MODEL,
  modelType: 'llm',
  modelConfig: { ctx_size: 2048 }
})
```

---

## Return batch translations as an array

PR: [#4237](https://github.com/tetherto/qvac/pull/4237)

**BEFORE:**
```typescript
const result = translate({ modelId, text: ['Good morning', 'Good night'], stream: false })
const translations = (await result.text).split('\n')

// streaming: entries arrive separated by a '\n' token
for await (const token of stream.tokenStream) {
  if (token === '\n') next()
  else current += token
}
```

**AFTER:**
```typescript
const result = translate({ modelId, text: ['Good morning', 'Good night'], stream: false })
const translations = await result.translations

// streaming: one whole translation per token, in input order
let i = 0
for await (const translation of stream.tokenStream) {
  console.log(texts[i++], '->', translation)
}
```

---

