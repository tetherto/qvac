# 🔌 API Changes v0.9.0

## OpenAI-compatible chat — reasoning_content, token usage, native tool-call replay

PR: [#3259](https://github.com/tetherto/qvac/pull/3259)

```ts
const info = await getLoadedModelInfo({ modelId })
if (!info.isDelegated && info.toolDialect === 'qwen35') {
  // render a replayed tool call in Qwen3.5's native XML form
}
```

```jsonc
  // request
  { "model": "…", "stream": true, "stream_options": { "include_usage": true }, "messages": [ … ] }
  // final SSE chunk
  { "object": "chat.completion.chunk", "choices": [], "usage": { "prompt_tokens": 12, "completion_tokens": 34, "total_tokens": 46 } }
```

---
