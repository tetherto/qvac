# 🔌 API Changes v0.13.0

## Configurable worker RPC init timeout and typed startup failure cause

PR: [#4159](https://github.com/tetherto/qvac/pull/4159)

```typescript
// 1. Configurable handshake timeout — qvac.config.json
{
  "rpcInitTimeoutMs": 120000
}
// or, taking precedence over the config file (and also raising `qvac doctor`'s probe):
//   QVAC_RPC_INIT_TIMEOUT_MS=120000 node app.js

// 2. Typed pre-handshake failure, always attached as the cause of RPC_INIT_TIMEOUT
import { WorkerStartupError, loadModel } from '@qvac/sdk'

try {
  await loadModel({ modelSrc, modelType: 'llamacpp-completion' })
} catch (error) {
  const cause = (error as Error).cause
  if (cause instanceof WorkerStartupError) {
    if (cause.workerExited) {
      // Dead, not slow — raising the timeout will not help.
      console.error(`worker died: code=${cause.exitCode} signal=${cause.exitSignal}`)
    } else {
      // Still running, just never connected — a longer rpcInitTimeoutMs may help.
      console.error('worker still running but never connected')
    }
    if (cause.stderrTail) console.error(cause.stderrTail)
  }
}
```

---

## Serve text translation on /qvac/v1/translate

PR: [#4165](https://github.com/tetherto/qvac/pull/4165)

```bash
# qvac.config.json
# {
#   "serve": {
#     "models": {
#       "de-en": {
#         "model": "BERGAMOT_DE_EN",
#         "config": { "engine": "Bergamot", "from": "de", "to": "en" }
#       }
#     }
#   }
# }

curl localhost:11434/qvac/v1/translate \
  -H 'content-type: application/json' \
  -d '{ "model": "de-en", "text": ["Guten Morgen", "Vielen Dank"] }'
```

```json
{
  "object": "translation",
  "model": "de-en",
  "translations": ["Good morning", "Thank you very much"]
}
```

```
data: {"object":"translation.item","index":0,"text":"Good morning", ...}
data: {"object":"translation.item","index":1,"text":"Thank you very much", ...}
data: {"object":"translation.done", ...}
data: [DONE]
```

---

## Surface modelConfig descriptions for every model type in qvac configure

PR: [#4172](https://github.com/tetherto/qvac/pull/4172)

```typescript
import { configSchemaForModelType } from '@qvac/sdk/schemas'

// Resolve a model type's modelConfig schema by canonical name, alias, or engine string
const schema = configSchemaForModelType('whisper') // 'tts-ggml', 'llm', 'diffusion', ...

// z.toJSONSchema(schema) surfaces each field's .describe() text as `description`,
// so tools (e.g. the CLI's `qvac configure`) can document config without a per-addon list.
```

---
