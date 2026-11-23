# 🔌 API Changes v0.20.0

## Accept named KV cache keys on /v1/chat/completions

PR: [#5830](https://github.com/tetherto/qvac/pull/5830)

`POST /v1/chat/completions` accepts a named KV cache session, which survives tool calls. Name it with the `X-QVAC-KV-Cache-Key` header, `metadata.qvac_kv_cache_key`, or OpenAI's `prompt_cache_key`, in that order of precedence. Requests without a key keep the automatic cache.

```bash
curl http://localhost:11435/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "my-llm",
    "prompt_cache_key": "my-session",
    "messages": [{"role": "user", "content": "What is the weather in London?"}]
  }'
```

- A key must be a nonempty string of at most 512 UTF-8 bytes; anything else returns `400 invalid_kv_cache_key`.
- A `prompt_cache_key` is combined with the messages up to the first user turn, so one key per user still gives each conversation its own cache. A header or metadata key is used as sent and selects the same session on `/v1/responses`.
- A keyed request reports SDK cache occupancy as `usage.qvac_cache_tokens`.
- `prompt_cache_key: null` counts as absent, on `/v1/responses` too, where it used to return `400 invalid_kv_cache_key`.

---
