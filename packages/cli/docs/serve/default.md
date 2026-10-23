# Default extension

The QVAC surface, mounted by `qvac serve` unless `--no-default` is passed. Its routes live
under `/qvac/v1`.

Server-wide behavior — authentication, CORS, model loading and `serve.models` — is
described in [README.md](README.md) and applies here. Its own configuration lives under
`serve.default`.

## Endpoints

| Method   | Path                  | Notes                                   |
| -------- | --------------------- | --------------------------------------- |
| `POST`   | `/qvac/v1/chat/batch` | Batch chat completion (LLM)             |
| `DELETE` | `/qvac/v1/kv_cache`   | Reclaim automatic KV cache              |
| `GET`    | `/qvac/v1/system`     | Host CPU, memory and GPU capacity       |
| `POST`   | `/qvac/v1/models/fit` | Whether models fit, before loading them |
| `POST`   | `/qvac/v1/translate`  | Text translation (NMT model)            |
| `POST`   | `/qvac/v1/ocr`        | Text recognition in an image            |

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

## `POST /qvac/v1/chat/batch`

Run several chat prompts through one loaded LLM in a single request, backed by the SDK's
`batchCompletion()`. The model decodes them together, which is faster than sending the same
prompts one by one.

`model` names a `serve.models` alias whose endpoint category is `chat` and whose
`config.parallel` is 2 or more. Up to `parallel` prompts decode at once and the rest queue. The
slots share the alias's `ctx_size`.

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
| 400  | `batch_not_enabled`          | The alias's `config.parallel` is below 2            |
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

## `POST /qvac/v1/ocr`

Read the text in an image with an OCR model, backed by the SDK's `ocr()`.

`model` names a `serve.models` alias whose endpoint category is `ocr`. That alias configures
the pipeline and the languages. Send the request as JSON or `multipart/form-data`.

| Field       | Type               | Required | Meaning                                                        |
| ----------- | ------------------ | -------- | -------------------------------------------------------------- |
| `model`     | `string`           | Yes      | A `serve.models` alias with endpoint category `ocr`            |
| `image`     | file, data URL, id | Yes      | A PNG, JPEG or BMP, in any [binary input](#binary-inputs) form |
| `paragraph` | `boolean`          | No       | Merge nearby lines into paragraph blocks. Default `false`      |
| `stream`    | `boolean`          | No       | Stream Server-Sent Events                                      |

Multipart flags are sent as the text `true` or `false`.

`blocks` lists the recognised text in reading order. `bbox` is `[xMin, yMin, xMax, yMax]` in
image pixels; `bbox` and `confidence` are present when the engine reports them.

```json
{
  "object": "ocr",
  "model": "ocr-en",
  "blocks": [{ "text": "Type to enter text", "bbox": [405, 393, 688, 433], "confidence": 0.98 }],
  "stats": { "detectionTime": 210, "recognitionTime": 95, "totalTime": 312 }
}
```

Streaming emits `ocr.chunk` events carrying `blocks` as the engine returns them, then one
`ocr.done` event with `stats`, then `data: [DONE]`. The engine currently returns all of an
image's blocks at once, so expect a single `ocr.chunk`. An error before it, such as an image the
engine cannot decode, returns JSON as usual; a failure after it arrives as a final
`{ "error": ... }` event.

OCR cannot be cancelled: a client disconnect drops the result, but the image is still read to
the end.

```bash
curl -sS http://localhost:11434/qvac/v1/ocr \
  -F model=ocr-en \
  -F image=@receipt.png
```

### Errors

The [binary input](#binary-inputs) errors apply to `image`, plus:

| HTTP | `error.code`               | When                                             |
| ---- | -------------------------- | ------------------------------------------------ |
| 400  | `invalid_json`             | Body is not valid JSON                           |
| 400  | `invalid_multipart`        | Multipart body could not be parsed               |
| 400  | `missing_model`            | `model` is missing                               |
| 400  | `missing_image`            | `image` is missing or empty                      |
| 400  | `unsupported_image_format` | `image` is not a PNG, JPEG or BMP, or is corrupt |
| 400  | `invalid_request`          | Unknown field, or a flag that is not boolean     |
| 400  | `invalid_model_type`       | Alias is not an `ocr` model                      |
| 404  | `model_not_found`          | Unknown alias                                    |
| 413  | `request_too_large`        | Upload over 100 MB                               |
| 503  | `model_not_loaded`         | Model not loaded and lazy loading is disabled    |

### Configuring an OCR model

```json
{
  "serve": {
    "models": {
      "ocr-en": {
        "model": "OCR_LATIN",
        "config": { "langList": ["en"] }
      }
    }
  }
}
```

The detector model is derived from the recognizer; set `config.detectorModelSrc` to override
it. `OCR_DOCTR` selects the language-agnostic DocTR pipeline.
