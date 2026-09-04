# Default extension

The QVAC surface, mounted by `qvac serve` unless `--no-default` is passed. Its routes live
under `/qvac/v1`.

Server-wide behavior — authentication, CORS, model loading and `serve.models` — is
described in [README.md](README.md) and applies here. Its own configuration lives under
`serve.default`.

## Endpoints

| Method   | Path                 | Notes                        |
| -------- | -------------------- | ---------------------------- |
| `DELETE` | `/qvac/v1/kv_cache`  | Reclaim automatic KV cache   |
| `POST`   | `/qvac/v1/translate` | Text translation (NMT model) |

## KV-cache retention

`/v1/chat/completions` and `/v1/responses` cache each conversation's prefix under
`~/.qvac/kv-cache`, so a follow-up turn only prefills the new tail. That directory grows on
the order of hundreds of megabytes per conversation, **but it is bounded** — you do not need
a sweeper of your own:

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
returned for a single input; a batch does not report stats.

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
