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
- Validate a newly written cache before marking it initialized. The addon
  commits or rolls back a cancelled or failed request itself (a cancel after
  prefill keeps the prompt and the tokens streamed so far), so keep the file
  rather than deleting it; only an auto cache with no key to move to is
  dropped, and the addon's copy of the conversation goes with the file.
- Use `deleteCache({ auto: true })` to reclaim inactive auto caches without
  deleting caller-owned named caches; active cache keys remain protected.

Implementation and focused tests are authoritative for the current cache format.

## Prime a prompt before the question arrives

Pass `prefill: true` to `completion()` with `kvCache: true` or a nonempty named
key. The run evaluates the history and tools, completes with stats and no answer,
and saves the prepared prefix. Await `run.final` before sending the question.
Prefill cannot use a forced `generationParams.tool_choice` (`required` or a tool
name, including `tool_search`). The default `auto` and `none` are supported.

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
