# Default extension

The QVAC surface, mounted by `qvac serve` unless `--no-default` is passed. Its routes live
under `/qvac/v1`.

Server-wide behavior — authentication, CORS, model loading and `serve.models` — is
described in [README.md](README.md) and applies here. Its own configuration lives under
`serve.default`.

## Endpoints

| Method   | Path                  | Notes                                   |
| -------- | --------------------- | --------------------------------------- |
| `DELETE` | `/qvac/v1/kv_cache`   | Reclaim automatic KV cache              |
| `GET`    | `/qvac/v1/system`     | Host CPU, memory and GPU capacity       |
| `POST`   | `/qvac/v1/models/fit` | Whether models fit, before loading them |
| `POST`   | `/qvac/v1/translate`  | Text translation (NMT model)            |

## Binary inputs

Routes that take an image or other file accept it in any of three forms, under the field name
the route documents:

- a `multipart/form-data` file part;
- a base64 data URL, `data:<type>;base64,...`, as a JSON string or a multipart text part;
- the `id` of a file uploaded with `POST /v1/files`, which needs the OpenAI surface mounted.

Uploads are capped at 100 MB per file and 10 files per request.

| HTTP | `error.code`       | When                                                         |
| ---- | ------------------ | ------------------------------------------------------------ |
| 400  | `invalid_data_url` | Data URL is not base64-encoded, or its payload is not base64 |
| 400  | `file_not_found`   | Value is neither a data URL nor the id of an uploaded file   |
| 400  | `empty_input`      | The input has no bytes                                       |

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

## `GET /qvac/v1/system`

Report the capacity of the host the server runs on, backed by the SDK's `getSystemResources()`.

`capabilities` describes the CPU, total memory and each GPU with its graphics drivers.
`?sample=true` adds `sample`: CPU load, memory in use (system-wide and for the serving process),
and per-GPU utilization at the time of the request.

Every figure is a metric with a `status`. Only `supported` carries a `value`, with the
`provenance` it was read from. `unavailable`, `unverified` and `failed` mean the platform could
not give a trustworthy number, and may carry a `reason`.

```bash
curl -sS "http://localhost:11434/qvac/v1/system?sample=true"
```

```json
{
  "object": "system",
  "capabilities": {
    "cpu": {
      "status": "supported",
      "value": {
        "logicalCores": { "status": "supported", "value": 14, "provenance": { "source": "os" } }
      }
    },
    "memory": {
      "totalBytes": {
        "status": "supported",
        "value": 25769803776,
        "provenance": { "source": "os" }
      }
    },
    "gpus": { "status": "supported", "value": [] }
  },
  "sample": {
    "sampledAt": 1760870400000,
    "cpu": { "status": "supported", "value": 0.12, "provenance": { "source": "os" } }
  }
}
```

The example is trimmed; each CPU, memory and GPU object carries every field, each as a metric.

### Errors

| HTTP | `error.code`              | When                                    |
| ---- | ------------------------- | --------------------------------------- |
| 400  | `invalid_sample`          | `sample` is not `true` or `false`       |
| 500  | `system_resources_failed` | The SDK could not read system resources |

## `POST /qvac/v1/models/fit`

Ask whether models are likely to fit in the host's memory before loading them, backed by the
SDK's `assessModelFit()`. Nothing is downloaded or loaded: each model's weightless registry
description is fetched (tens of KB) and the engine's own fitter runs against it, falling back to
a floor computed from catalog facts.

| Field                  | Type                           | Required | Meaning                                                  |
| ---------------------- | ------------------------------ | -------- | -------------------------------------------------------- |
| `models`               | `object[]`                     | Yes      | Up to 16 models, assessed together under one budget      |
| `models[].model`       | `string`                       | Yes      | A `serve.models` alias, or an SDK model constant name    |
| `models[].modelConfig` | `object`                       | No       | Config to assess with, merged over an alias's own config |
| `execution`            | `"sequential" \| "concurrent"` | No       | Co-residency assumption; `sequential` by default         |
| `policy`               | `"interactive-v1"`             | No       | Headroom policy; withholds 20% of available memory       |

An alias is assessed with the config it would load with. `modelConfig` is merged over it key
by key, nested objects included, so `{"ctx_size": 32768}` asks about a longer context and an
override inside `contextParams` keeps the alias's other context params. Model sources cannot be given in the request:
companion sources in `modelConfig` (`*ModelSrc` keys) must name SDK model constants, so a request
never makes the server read a path or URL of its choosing.

The answer is advisory. `verdict` is `likely-fits`, `likely-too-large` or `unknown`, combined
across every model under `execution`. `unknown` means the evidence supports neither answer, not
"no". `models` carries one verdict per entry in request order, and `budget` the memory it was
judged against.

```bash
curl -sS http://localhost:11434/qvac/v1/models/fit \
  -H "Content-Type: application/json" \
  -d '{"models":[{"model":"my-llm","modelConfig":{"ctx_size":8192}}]}'
```

```json
{
  "object": "model_fit",
  "verdict": "likely-fits",
  "basis": "system-memory",
  "execution": "sequential",
  "evidence": "native-fit",
  "budget": {
    "totalBytes": 25769803776,
    "usedBytes": 21211299840,
    "availableBytes": 4558503936,
    "reservedBytes": 911700787,
    "availableAfterReserveBytes": 3646803149
  },
  "models": [
    {
      "model": "my-llm",
      "name": "QWEN3_600M_INST_Q4",
      "verdict": "likely-fits",
      "evidence": "native-fit",
      "device": "gpu",
      "reasons": ["..."]
    }
  ],
  "reasons": ["..."],
  "assumptions": ["..."]
}
```

### Errors

| HTTP | `error.code`        | When                                                       |
| ---- | ------------------- | ---------------------------------------------------------- |
| 400  | `invalid_json`      | Body is not valid JSON                                     |
| 400  | `invalid_models`    | `models` is missing or empty, or an entry is malformed     |
| 400  | `too_many_models`   | `models` carries more than 16 entries                      |
| 400  | `invalid_execution` | `execution` is not `sequential` or `concurrent`            |
| 400  | `invalid_policy`    | `policy` is not `interactive-v1`                           |
| 400  | `invalid_model_src` | A companion source in `modelConfig` is not an SDK constant |
| 400  | `invalid_request`   | The body carries an unknown field                          |
| 404  | `model_not_found`   | An entry names neither an alias nor an SDK model constant  |
| 500  | `model_fit_failed`  | The SDK assessment failed                                  |

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
