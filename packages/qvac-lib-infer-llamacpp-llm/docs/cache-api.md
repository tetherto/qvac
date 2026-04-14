# KV Cache API

Cache control is managed through `runOptions`, the second argument to `model.run()`.

## runOptions reference

| Option | Type | Description |
| --- | --- | --- |
| `cacheKey` | `string` | Path to the cache file. Omit to disable caching. |
| `saveCacheToDisk` | `boolean` | `true` writes the cache to the `cacheKey` path after inference. If omitted, cache stays in RAM and only auto-saves on cache switch or clear. |
| `prefill` | `boolean` | Evaluate prompt without generating a response. |
| `generationParams` | `object` | Per-run overrides for temp, top_p, top_k, predict, seed, penalties. |

## Enable caching

Pass `cacheKey` with a file path. The KV cache is loaded from that file if it exists, or created fresh if it doesn't.

```js
await model.run(
  [{ role: 'user', content: 'What is bitcoin?' }],
  { cacheKey: 'session.bin' }
)
```

## Continue a conversation

Use the same `cacheKey`. The existing cache is reused — only the new tokens are evaluated.

```js
await model.run(
  [{ role: 'user', content: 'Tell me more' }],
  { cacheKey: 'session.bin' }
)
```

## Save the cache to disk

`saveCacheToDisk: true` writes the full in-memory KV cache state to the `cacheKey` file after inference completes.

```js
await model.run(
  [{ role: 'user', content: 'Hello' }],
  { cacheKey: 'session.bin', saveCacheToDisk: true }
)
```

Without `saveCacheToDisk`, the cache stays in RAM. It is only written to disk automatically in two cases:

1. **Switching to a different `cacheKey`** — the old session is saved before loading the new one.
2. **Omitting `cacheKey`** — the active session is saved and then cleared.

### saveCacheToDisk on some turns, omitted on others

```js
// Turn 1: saved to disk
await model.run([{ role: 'user', content: 'Hello' }], { cacheKey: 'a.bin', saveCacheToDisk: true })

// Turn 2: RAM has turn 1 + 2, but a.bin on disk still only has turn 1
await model.run([{ role: 'user', content: 'More' }], { cacheKey: 'a.bin' })

// Turn 3: a.bin on disk updated with turn 1 + 2 + 3
await model.run([{ role: 'user', content: 'Continue' }], { cacheKey: 'a.bin', saveCacheToDisk: true })
```

### Started without saving, then saved later

```js
// Turn 1: cache in RAM only, no file written
await model.run([{ role: 'user', content: 'Hello' }], { cacheKey: 'a.bin' })

// Turn 2: saves everything (turn 1 + 2) to disk
await model.run([{ role: 'user', content: 'More' }], { cacheKey: 'a.bin', saveCacheToDisk: true })
```

## Switch between cache files

Passing a different `cacheKey` auto-saves the old session to disk, then loads the new one.

```js
await model.run([{ role: 'user', content: 'Topic A' }], { cacheKey: 'session1.bin' })

// session1.bin is auto-saved, then session2.bin is loaded
await model.run([{ role: 'user', content: 'Topic B' }], { cacheKey: 'session2.bin' })
```

## Single-shot inference (no caching)

Omit `cacheKey`. No cache is used and the context is reset after each call.

```js
await model.run([{ role: 'user', content: 'One-off question' }])
```

If caching was previously active, omitting `cacheKey` auto-saves the active session to disk and clears it.

## Replay with dynamic tools

When tools change between turns, omit `cacheKey` and send the full conversation history. This gives the model a fresh context with the new tool set.

```js
await model.run(
  [
    { role: 'system', content: 'You are a helpful assistant.' },
    ...history,
    { role: 'user', content: 'Calculate 256 * 128' },
    TOOL_CALCULATOR
  ]
)
```

## Cache token count

`CacheTokens` is available in `response.stats` after every run. No dedicated command needed.

```js
const response = await model.run(
  [{ role: 'user', content: 'Hello' }],
  { cacheKey: 'session.bin' }
)
console.log(response.stats.CacheTokens)
```
