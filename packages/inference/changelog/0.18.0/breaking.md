# 💥 Breaking Changes v0.18.0

## Remove SDK dynamic tools mode (toolsMode)

PR: [#3380](https://github.com/tetherto/qvac/pull/3380)

**BEFORE:**

```typescript
import { loadModel, TOOLS_MODE, type ToolsMode } from '@qvac/inference'

const modelId = await loadModel({
  modelSrc: QWEN3_1_7B_INST_Q4,
  modelType: 'llm',
  modelConfig: { ctx_size: 4096, tools: true, toolsMode: TOOLS_MODE.dynamic }
})
```

**AFTER:**

```typescript
import { loadModel } from '@qvac/inference'

const modelId = await loadModel({
  modelSrc: QWEN3_1_7B_INST_Q4,
  modelType: 'llm',
  modelConfig: { ctx_size: 4096, tools: true }
})
```

`TOOLS_MODE` / `ToolsMode` exports are removed; tools are always prepended after the system message (the previous static default). The `toolsMode` key must be removed: passing it to `loadModel` now throws a validation error rather than being ignored.

---

## Add CosyVoice3 TTS support

PR: [#3857](https://github.com/tetherto/qvac/pull/3857)

**BEFORE:**

```typescript
textToSpeech({ modelId, text, pace: 'very fast' }) // accepted, engine-dependent behavior
```

**AFTER:**

```typescript
textToSpeech({ modelId, text, pace: 'fast' }) // pace: 'slow' | 'moderate' | 'fast'
```

---
