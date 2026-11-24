# QVAC CLI v0.20.0 Release Notes

📦 **NPM:** https://www.npmjs.com/package/@qvac/cli/v/0.20.0

QVAC CLI 0.20.0 brings named KV cache sessions to `/v1/chat/completions`, so coding agents that talk to `qvac serve --openai` over chat completions stop re-reading the whole prompt after every tool call.

## New APIs

### Named KV cache sessions on `/v1/chat/completions`

Chat completions already cached each conversation automatically, by hashing the message history to find the previous turn. That lookup stops matching once the history ends in a tool call and its results, so an agent loop re-read the full prompt on every step. A request can now name its cache session, as `/v1/responses` already allowed, and a named session survives tool calls. On Qwen3.5 9B with a 6.6k-token prompt, the step after a tool result went from 18.5 s to 2.8 s.

Name the session with one of, in order of precedence: the `X-QVAC-KV-Cache-Key` header, `metadata.qvac_kv_cache_key` in the body, or OpenAI's `prompt_cache_key` in the body.

```bash
curl http://localhost:11435/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "my-llm",
    "prompt_cache_key": "my-session",
    "messages": [{"role": "user", "content": "What is the weather in London?"}]
  }'
```

A key must be a nonempty string of at most 512 UTF-8 bytes; anything else returns `400 invalid_kv_cache_key`. Use one key per conversation and resend it with the growing history. A `prompt_cache_key` is combined with the messages up to the first user turn, so a client that sends one key per user, as OpenAI suggests, still gets a cache per conversation. A header or metadata key is used as sent and selects the same session on `/v1/responses`.

Requests without a key keep the automatic cache. A keyed request reports SDK cache occupancy as `usage.qvac_cache_tokens`; this is not a count of reused tokens. Named caches on both endpoints share one 4 GiB quota and 24-hour idle TTL.

The QVAC plugins for OpenCode and OpenClaw have the host send its session id as `prompt_cache_key` from their 0.5.0 releases. The pi coding agent sends one when `PI_CACHE_RETENTION=long` is set.

### `prompt_cache_key: null` counts as absent

Both `/v1/chat/completions` and `/v1/responses` now treat `prompt_cache_key: null` as no key. `/v1/responses` used to answer `400 invalid_kv_cache_key`.
