# 💥 Breaking Changes v0.22.0

## Assess every candidate with its engine and drop the coefficients

PR: [#4864](https://github.com/tetherto/qvac/pull/4864)

**BEFORE:**

```typescript
const result = await assessModelFit({ models })
result.evidence // 'calibration' | 'computed-only' | 'native-fit'
result.estimate // { lowerBoundBytes, upperBoundBytes }
result.models[0].estimate // same
```

**AFTER:**

```typescript
const result = await assessModelFit({ models })
result.evidence // 'computed-only' | 'native-fit'
// `estimate` is removed from the result and from each model.
// `floorBytes` carries the bound under `computed-only`.
// A single candidate the engine calls a fit can now be `likely-too-large`:
// the `interactive-v1` reserve applies on top of the engine's own headroom.
```

---

## Let a load decide what the engine fitter's verdict does to it

PR: [#4889](https://github.com/tetherto/qvac/pull/4889)

**BEFORE:**

```typescript
// Skipping the fit probe was process-wide, and also disabled the engine
// verdict for assessModelFit.
QVAC_ADVISORY_MODEL_FIT = 0
```

**AFTER:**

```typescript
await loadModel({ modelSrc, modelType, modelFitPolicy: 'off' })
```

```json
{ "modelFitPolicy": "off" }
```

---

## Refresh model constants from registry

PR: [#4929](https://github.com/tetherto/qvac/pull/4929)

**BEFORE:**

```typescript
import { PARAKEET_TDT_MODEL } from '@qvac/inference'
```

**AFTER:**

```typescript
import { loadModel, PARAKEET_TDT_0_6B_V3_F16 } from '@qvac/inference'

await loadModel({ modelSrc: PARAKEET_TDT_0_6B_V3_F16 })
```

---

## Reduce split addons' binding.js to require('#host-addon')

PR: [#4938](https://github.com/tetherto/qvac/pull/4938)

Consumers are native addon packages (`llm-llamacpp`, `embed-llamacpp`, and the other engine addons), not application manifests.

**BEFORE:** native consumer

```cmake
qvac_addon_finalize(${addon} SUBDIR "${BACKENDS_SUBDIR_VALUE}")
```

```cpp
ggml_backend_load_all();
```

**AFTER:**

```cmake
qvac_addon_finalize(${addon})
```

```cpp
#include <qvac-fabric.h>
qvac_fabric_load_backends();
```

`require('@qvac/fabric/backends')` is removed. A source-built fabric no longer serves its own `prebuilds/<host>`; run `npm run link:platform` to expose the build as `node_modules/@qvac/fabric-<suffix>`.

---

## Send the full conversation every cached turn

PR: [#4951](https://github.com/tetherto/qvac/pull/4951)

**BEFORE:**

```typescript
completion({
  modelId,
  history,
  kvCache: 'chat',
  generationParams: { remove_thinking_from_context: true }
})
```

**AFTER:**

```typescript
completion({ modelId, history, kvCache: 'chat' })
```

- A changed tool set on a named key reuses the same cache file, trimmed where it differs.
- A deleted attachment now fails later cached turns, as it does uncached.
- `stats.promptTokens` on a cached turn counts only the tokens processed that turn, not the whole prompt; reused cache tokens are excluded.

---

## Expose GPU backend selection for LLM, embeddings, and VLA

PR: [#5005](https://github.com/tetherto/qvac/pull/5005)

**BEFORE:**

```kotlin
LoadModelSrcRequestGgmlVlaModelConfig(
    backend = LoadModelSrcRequestGgmlVlaModelConfigBackend.CPU
)
```

**AFTER:**

```kotlin
LoadModelSrcRequestGgmlVlaModelConfig(backend = "cpu")
```

---

## Move the SDK onto the fabric 0.22 addon set

PR: [#5089](https://github.com/tetherto/qvac/pull/5089)

**BEFORE:**

```json
"@qvac/ggml-rpc-server": "^0.1.2"
```

**AFTER:**

```json
"@qvac/ggml-rpc-server": "^0.5.1"
```

---

## Raise engines.bare to >=1.32.0

The published 0.21.0 engine accepted Bare `>=1.30.3`. This cut requires `>=1.32.0`.

**BEFORE:**

```json
"engines": { "bare": ">=1.30.3" }
```

**AFTER:**

```json
"engines": { "bare": ">=1.32.0" }
```

---
