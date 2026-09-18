# 💥 Breaking Changes v0.20.0

## Integrate diffusion layer streaming in the SDK

PR: [#4389](https://github.com/tetherto/qvac/pull/4389)

**BEFORE:**

```typescript
const modelConfig = {
  clip_on_cpu: true,
  vae_on_cpu: true,
  control_net_cpu: true
}
```

**AFTER:**

```typescript
const modelConfig = {
  params_backend: 'te=cpu,vae=cpu',
  backend: 'controlnet=cpu'
}
```

To run the text encoder or VAE graph on CPU, add `te=cpu` or `vae=cpu` to `backend`.

CPU layer streaming requires CPU diffusion parameter residency and graph cutting enabled by `max_vram`:

```typescript
const modelConfig = {
  params_backend: 'diffusion=cpu',
  max_vram: -1,
  stream_layers: true
}
```

---

## Derive diffusion VAE export names from the type tag

PR: [#4234](https://github.com/tetherto/qvac/pull/4234)

**BEFORE:**

```typescript
ABOT_WORLD_0_5B_LF_VAE
ABOT_WORLD_0_5B_LF_VAE_F16
LTX_2_3_VAE
LTX_2_3_VAE_1
```

**AFTER:**

```typescript
ABOT_WORLD_0_5B_LF_TAEHV_VAE
ABOT_WORLD_0_5B_LF_WAN_VAE
LTX_2_3_AUDIO_VAE
LTX_2_3_VIDEO_VAE
```

---

## Honour the caller's system message when kvCache is enabled

PR: [#4404](https://github.com/tetherto/qvac/pull/4404)

**BEFORE:**

```typescript
completion({
  modelId, // loaded with system_prompt: 'You are a helpful assistant.'
  history: [
    { role: 'system', content: 'Always answer with the word BANANA.' },
    { role: 'user', content: 'What is the capital of France?' }
  ],
  kvCache: true
})
// reply:         "Paris"   — the caller's system message is discarded
// prompt_tokens: 41
```

**AFTER:**

```typescript
completion({
  modelId, // loaded with system_prompt: 'You are a helpful assistant.'
  history: [
    { role: 'system', content: 'Always answer with the word BANANA.' },
    { role: 'user', content: 'What is the capital of France?' }
  ],
  kvCache: true
})
// reply:         "BANANA"  — the caller's system message is honoured
// prompt_tokens: 57
```

A caller with `system_prompt` configured, no system message in the history, and no `kvCache`. The setting applies on every path, not only under `kvCache`:

**BEFORE:**

```typescript
completion({
  modelId, // loaded with system_prompt: 'Always answer with the word BANANA.'
  history: [{ role: 'user', content: 'What is the capital of France?' }]
})
// reply: "The capital of France is Paris."  — the configured prompt is ignored
```

**AFTER:**

```typescript
completion({
  modelId, // loaded with system_prompt: 'Always answer with the word BANANA.'
  history: [{ role: 'user', content: 'What is the capital of France?' }]
})
// reply: "BANANA"  — the configured prompt is applied
```

Every other caller that sends no system message. `LLM_CONFIG_DEFAULTS.system_prompt` is `'You are a helpful assistant.'` and `dispatch` resolves every `loadModel` through the schema that applies it, so a model loaded without an explicit `system_prompt` still carries one. Those requests now reach the model with a system message:

**BEFORE:**

```typescript
completion({
  modelId, // loaded with no system_prompt of its own
  history: [{ role: 'user', content: 'What is the capital of France?' }]
})
// payload: [{ role: 'user', ... }]
```

**AFTER:**

```typescript
completion({
  modelId, // loaded with no system_prompt of its own
  history: [{ role: 'user', content: 'What is the capital of France?' }]
})
// payload: [{ role: 'system', content: 'You are a helpful assistant.' }, { role: 'user', ... }]
```

---

## Integrate Fabric 10549.1.0 consumers in SDK

PR: [#4439](https://github.com/tetherto/qvac/pull/4439)

Fabric 10549.1.0 dropped llama.cpp's unused row split.

Completion models: `modelConfig['split-mode']` is `'none'`, `'layer'` or `'tensor'`. `'row'` is rejected.
Embedding models: `modelConfig.splitMode` is `'none'` or `'layer'`. `'row'` is rejected.
`'tensor'` on completion models is unaffected.

On embeddings, `'row'` did not do tensor parallelism; it already behaved as `'layer'`. Embeddings have no `'tensor'` mode. Use `'layer'`.

**BEFORE:**

```typescript
// completion
modelConfig: { 'split-mode': 'row' }

// embedding
modelConfig: { splitMode: 'row' }
```

**AFTER:**

```typescript
// completion
modelConfig: { 'split-mode': 'layer' } // or 'tensor'

// embedding
modelConfig: { splitMode: 'layer' }
```

---

## Add Nemotron SDK support

PR: [#4357](https://github.com/tetherto/qvac/pull/4357)

Parakeet `modelConfig.language` must be `auto`, a short code (`en`, `hi`), or `code-region` (`en-US`, `hi-IN`). `zh-Hans-CN` and names like `english` now fail at `loadModel`. Whisper `language` is unchanged.

**BEFORE:**

```typescript
modelConfig: {
  language: 'zh-Hans-CN'
}
```

**AFTER:**

```typescript
modelConfig: {
  language: 'zh'
}
```

---
