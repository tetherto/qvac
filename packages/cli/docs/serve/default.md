# Default extension

The QVAC surface, mounted by `qvac serve` unless `--no-default` is passed. Its routes live
under `/qvac/v1`.

Server-wide behavior — authentication, CORS, model loading and `serve.models` — is
described in [README.md](README.md) and applies here. Its own configuration lives under
`serve.default`.

## Endpoints

| Method   | Path                  | Notes                        |
| -------- | --------------------- | ---------------------------- |
| `POST`   | `/qvac/v1/chat/batch` | Batch chat completion (LLM)  |
| `DELETE` | `/qvac/v1/kv_cache`   | Reclaim automatic KV cache   |
| `POST`   | `/qvac/v1/translate`  | Text translation (NMT model) |

## KV-cache retention

`/v1/chat/completions` caches each conversation's prefix under `~/.qvac/kv-cache`, so a
follow-up turn only prefills the new tail. It is the only endpoint that does: `/v1/responses`
and `/v1/completions` run uncached, so they leave nothing here to reclaim. That directory
grows on the order of hundreds of megabytes per conversation, **but it is bounded** — you do
not need a sweeper of your own:

| Bound           | Value                                             |
| --------------- | ------------------------------------------------- |
| Size quota      | 4 GiB least-recently-used (512 MiB on mobile)     |
| Idle TTL        | 24 hours                                          |
| Sweep frequency | After a cached turn finishes, at most every 5 min |

Caches held by an in-flight request are never evicted.

**Named caches are not covered.** The policy applies only to the _automatic_ caches these
endpoints create. A caller-owned named cache — `completion({ kvCache: "my-session" })`
through the SDK — is exempt from both the quota and the TTL, and the endpoint below never
touches it. Clean those up with the SDK's `deleteCache({ kvCacheKey })`. Serve itself only
ever creates automatic caches; it does not use named keys.

## `POST /qvac/v1/chat/batch`

Run several chat prompts through one loaded LLM in a single request, backed by the SDK's
`batchCompletion()`. The model decodes them together, which is faster than sending the same
prompts one by one.

`model` names a `serve.models` alias whose endpoint category is `chat`. Concurrency comes from
that alias's `config.parallel`: at `parallel: 1` the prompts run one after another, and above
it up to `parallel` decode at once. The slots share the alias's `ctx_size`.

| Field     | Type       | Required | Meaning                                              |
| --------- | ---------- | -------- | ---------------------------------------------------- |
| `model`   | `string`   | Yes      | A `serve.models` alias with endpoint category `chat` |
| `prompts` | `object[]` | Yes      | 1 to 64 prompts                                      |

Each prompt takes these `/v1/chat/completions` fields: `messages` (required), `tools`,
`tool_choice`, `parallel_tool_calls`, `response_format`, `temperature`, `top_p`, `seed`,
`frequency_penalty`, `presence_penalty`, `max_tokens` / `max_completion_tokens` and
`reasoning_budget`. It may also carry an `id`, unique within the batch. Tools with
`defer_loading` are not supported.

`results` comes back in prompt order. Each entry has its `id` (the one given, or one the server
assigned), `index`, an assistant `message` shaped like a `/v1/chat/completions` choice, and
`finish_reason`. `stats` covers the whole batch; the engine does not break it down per prompt.

```json
{
  "object": "chat.batch",
  "model": "my-llm",
  "results": [
    {
      "id": "cherry",
      "index": 0,
      "message": { "role": "assistant", "content": "CHERRY" },
      "finish_reason": "stop"
    },
    {
      "id": "banana",
      "index": 1,
      "message": { "role": "assistant", "content": "BANANA" },
      "finish_reason": "stop"
    }
  ],
  "stats": { "tokensPerSecond": 88.4 }
}
```

The batch succeeds or fails as a whole. The request blocks until every prompt finishes, and a
client disconnect cancels it.

```bash
curl -sS http://localhost:11434/qvac/v1/chat/batch \
  -H "Content-Type: application/json" \
  -d '{"model":"my-llm","prompts":[
        {"id":"cherry","messages":[{"role":"user","content":"Reply with only the word CHERRY."}]},
        {"id":"banana","messages":[{"role":"user","content":"Reply with only the word BANANA."}]}
      ]}'
```

### Errors

| HTTP | `error.code`                 | When                                                |
| ---- | ---------------------------- | --------------------------------------------------- |
| 400  | `invalid_json`               | Body is not valid JSON                              |
| 400  | `missing_model`              | `model` is missing                                  |
| 400  | `invalid_prompts`            | `prompts` is missing, empty or carries a bad prompt |
| 400  | `too_many_prompts`           | `prompts` carries more than 64 entries              |
| 400  | `duplicate_prompt_id`        | Two prompts share an `id`                           |
| 400  | `invalid_request`            | The body carries an unknown top-level field         |
| 400  | `deferred_tools_unsupported` | A prompt's tool sets `defer_loading`                |
| 400  | `tools_not_enabled`          | A prompt has `tools` and the alias lacks `tools`    |
| 400  | `invalid_response_format`    | Bad `response_format`, or one combined with `tools` |
| 400  | `invalid_tool_choice`        | `tool_choice` names no declared tool                |
| 400  | `unsupported_image_content`  | An image is not a PNG or JPEG data URL              |
| 400  | `invalid_model_type`         | Alias is not a `chat` model                         |
| 400  | `context_length_exceeded`    | The batch does not fit the context window           |
| 404  | `model_not_found`            | Unknown alias                                       |
| 429  | `request_rejected_by_policy` | The model is busy and its policy rejects queueing   |
| 502  | `inference_failed`           | Inference failed                                    |
| 503  | `model_not_loaded`           | Model not loaded and lazy loading is disabled       |

### Configuring a batch model

```json
{
  "serve": {
    "models": {
      "my-llm": {
        "model": "QWEN3_600M_INST_Q4",
        "config": { "ctx_size": 8192, "parallel": 4 }
      }
    }
  }
}
```

## `DELETE /qvac/v1/kv_cache`

Frees every automatic KV cache no in-flight request is using, immediately, rather than
waiting for the quota or the TTL. Use it when reclaiming disk matters more than keeping
conversations warm: deleting a cache costs the next turn a full prefill instead of a partial
one, and loses no conversation content, since a KV cache is derived data.

```bash
curl -X DELETE http://localhost:11434/qvac/v1/kv_cache
```

```json
{ "object": "kv_cache.reclaim", "deleted": true }
```

> **Scope is the host, not this server.** `~/.qvac/kv-cache` is shared by every QVAC process
> running under the same home directory, so this reclaims another local process's automatic
> caches too. That is the same scope the automatic sweep already acts on. Nothing in a cache
> path identifies the process that wrote it, because cache identity is content-derived, so
> per-server scoping is not available.

This route needs the QVAC surface mounted. It is absent under `--no-default`, and therefore
under the deprecated `qvac serve openai`, which implies it.

### Errors

| HTTP | `error.code`              | When                  |
| ---- | ------------------------- | --------------------- |
| 500  | `kv_cache_reclaim_failed` | The SDK delete failed |

## `POST /qvac/v1/translate`

Translate text with an NMT model, backed by the SDK's `translate()`.

`model` names a `serve.models` alias whose endpoint category is `translation`. That alias
configures the engine and the language direction.

| Field    | Type                 | Required | Meaning                                                     |
| -------- | -------------------- | -------- | ----------------------------------------------------------- |
| `model`  | `string`             | Yes      | A `serve.models` alias with endpoint category `translation` |
| `text`   | `string \| string[]` | Yes      | One input, or an array of up to 100 for batch               |
| `stream` | `boolean`            | No       | Stream Server-Sent Events                                   |

`translations` comes back in the order the inputs were given, one entry per input. `stats` is
returned for a single input and describes that request alone. A batch does not report stats,
and neither does the first single input after a batch on the same model, whose work the engine
cannot separate from the batch's.

```json
{
  "object": "translation",
  "model": "ta-en",
  "translations": ["Hello, world."],
  "stats": { "totalTime": 41 }
}
```

Streaming a single input emits `translation.chunk` events carrying `delta` as the text is
decoded. Streaming an array emits one `translation.item` per input, carrying `index` and the
whole `text`, and these arrive together once the batch finishes. Both end with one
`translation.done` event, then `data: [DONE]`.

A client disconnect cancels the request and its result is dropped.

```bash
curl -sS http://localhost:11434/qvac/v1/translate \
  -H "Content-Type: application/json" \
  -d '{"model":"ta-en","text":"வணக்கம் உலகம்"}'
```

### Errors

| HTTP | `error.code`         | When                                          |
| ---- | -------------------- | --------------------------------------------- |
| 400  | `invalid_json`       | Body is not valid JSON                        |
| 400  | `missing_model`      | `model` is missing                            |
| 400  | `missing_text`       | `text` is missing or empty                    |
| 400  | `too_many_inputs`    | `text` carries more than 100 inputs           |
| 400  | `invalid_request`    | The body carries an unknown field             |
| 400  | `invalid_model_type` | Alias is not a `translation` model            |
| 404  | `model_not_found`    | Unknown alias                                 |
| 503  | `model_not_loaded`   | Model not loaded and lazy loading is disabled |

### Configuring a translation model

```json
{
  "serve": {
    "models": {
      "ta-en": {
        "model": "BERGAMOT_TA_EN",
        "config": { "engine": "Bergamot", "from": "ta", "to": "en" }
      }
    }
  }
}
```
