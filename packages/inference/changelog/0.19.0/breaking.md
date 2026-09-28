# 💥 Breaking Changes v0.19.0

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
const id = await loadModel({ modelSrc })
await heartbeat()
```

- Removed: `startQVACProvider`, `stopQVACProvider`, `loadModel(...).delegate`, `heartbeat(...).delegate`.
- `unloadModel` response no longer includes `hasActiveProviders`; `getLoadedModelInfo` no longer returns `isDelegated`/`providerInfo`.
- Profiler resource gauges drop the `origin` field, and the per-call `resourceOrigin` profiling option is removed.
- Removed error classes/codes: `ProviderStartFailedError`, `ProviderStopFailedError`, `ModelIsDelegatedError`, `DelegateNoFinalResponseError`, `DelegateConnectionFailedError`, `DelegateProviderError`.

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

| Before           | After                                    |
| ---------------- | ---------------------------------------- |
| `no_mmap: true`  | `load_mode: 'none'`                      |
| `no_mmap: false` | omit `load_mode`, or `load_mode: 'mmap'` |
| omitted          | omitted (addon default `mmap`)           |
| any other value  | validation error                         |

The same mapping applies to `deviceDefaults.llm` and `deviceDefaults['llamacpp-completion']` in a config file.

`load_mode` also reaches modes `no_mmap` never could: `'mlock'`, `'mmap+mlock'` and `'dio'`.

---

## Drop n_discarded from the config schema

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

for await (const token of stream.tokenStream) {
  if (token === '\n') next()
  else current += token
}
```

**AFTER:**

```typescript
const result = translate({ modelId, text: ['Good morning', 'Good night'], stream: false })
const translations = await result.translations

let i = 0
for await (const translation of stream.tokenStream) {
  console.log(texts[i++], '->', translation)
}
```

---
