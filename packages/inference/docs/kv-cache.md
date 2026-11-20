# LLM KV cache

KV-cache behavior is owned by the llama.cpp completion plugin under
`src/plugins/builtin/llamacpp-completion/ops/`, with shared path helpers under
`src/plugins/ops/` and the inference utilities.

- Send the whole conversation and the tools on every turn, cached or not. The
  addon compares the rendered prompt with the tokens the cache file holds and
  decodes only what follows the shared prefix, so the plugin keeps no record of
  what a file covers.
- Keep on-disk state and active references under one session owner.
- Use the session begin/commit/rollback lifecycle; do not update individual cache
  bookkeeping structures from handlers.
- Serialize writes for one cache identity and keep cache keys portable across
  case-sensitive and case-insensitive filesystems.
- Name a cache file by key and system prompt only. A changed tool set or an
  edited history must reach the same file so the addon can trim it at the
  divergence point.
- Write every turn's cache with `saveCache` once the run finishes. The addon
  otherwise keeps it in memory, and the session, the auto-cache rename and a
  restart all read the file.
- Validate a newly written cache before marking it initialized. The addon commits
  or rolls back cancelled and failed requests, so keep the last committed file
  after an ordinary request failure. A cancellation after prefill keeps the
  prompt and the tokens streamed so far. If the addon refuses to load the turn's
  own file, roll back the turn, delete the file and discard the addon's copy.
  A failure loading a seed leaves the seed alone. Also roll back an auto cache
  when the turn has no key to save it under.
- Use `deleteCache({ auto: true })` to reclaim inactive auto caches without
  deleting caller-owned named caches; active cache keys remain protected.
- Prompt-prefix sharing across cache identities is opt-in at model load.
  `cacheShareAcrossKeys` defaults to `false` when it is omitted, so a keyed request
  reuses only its own state and a keyless request starts cold and resets. Set it
  to `true` to let any request reuse the longest prefix held by another
  conversation; keyless state then remains available in model memory. The
  setting stays part of the model id, but not of the cache folder name, so
  turning it on keeps reading the files existing conversations already wrote.
- The cache folder name also ignores other settings that cannot change what a
  cache file holds. A sent `verbosity` counts as its default `0`, so loads that
  send different values share a folder. Unlike `cacheShareAcrossKeys`, which
  the SDK always fills in, an omitted `verbosity` stays omitted, so a load that
  omits it and one that sends it get different folders. `openclCacheDir` and
  `cacheRamMib` are left out. A load whose folder name differs from its model
  id records the mapping under `~/.qvac/kv-cache-dir-ids/`, so
  `deleteCache({ kvCacheKey, modelId })` finds the folder in a process that has
  not loaded the model.

Implementation and focused tests are authoritative for the current cache format.

## Prime a prompt before the question arrives

Pass `prefill: true` to `completion()` with `kvCache: true` or a nonempty named
key. The run evaluates the history and tools, completes with stats and no answer,
and saves the prepared prefix. Await `run.final` before sending the question.
Prefill cannot use a forced `generationParams.toolChoice` (`required` or a tool
name, including `tool_search`). The default `auto` and `none` are supported.
A prefill needs at least one message: a system message in the history, or the
`modelConfig.systemPrompt` set at load. Tools alone are rejected with
`RequestValidationFailedError`.

```typescript
const history = [{ role: 'system', content: 'You are a helpful assistant.' }]
await completion({ modelId, history, tools, stream: false, kvCache: 'chat', prefill: true }).final
const answer = await completion({
  modelId,
  history: [...history, { role: 'user', content: 'What is the weather in Lugano?' }],
  tools,
  stream: false,
  kvCache: 'chat'
}).final
```

Load with `modelConfig.tools: true` to include tool definitions. Send the same
system prompt and tools again with the user question; the addon reuses their
token prefix and evaluates the remaining user-turn/template suffix. Named
caches persist at the same identity. Auto-prefill caches are committed under
the normalized complete history, without an empty assistant message.
With `kvCache: true`, the first question moves that cache to the conversation's
new history, so the prime serves one conversation. Use a named key for reuse
across conversations, or prime each conversation separately.

Requires `@qvac/llm-llamacpp` 0.64.1 or later for affected no-user templates.
Arbitrary custom templates may fall back to normal rendering without full
prefix reuse. This is a library request option; the CLI load-config picker and
OpenAI-compatible HTTP endpoints do not expose cache priming.
