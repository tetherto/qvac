# `qvac serve openai`

The CLI exposes an **OpenAI-compatible HTTP API** (`qvac serve openai`) so tools and SDKs that target OpenAI can run against local QVAC models.

This document describes the supported routes and how to configure `serve.models` for each capability. For general CLI usage, see [README.md](../README.md).

## Implemented endpoints (today)

| Method | Path | Notes |
|--------|------|--------|
| `GET` | `/v1/models` | Lists **loaded** models |
| `GET` | `/v1/models/{id}` | Model metadata |
| `DELETE` | `/v1/models/{id}` | Unload |
| `POST` | `/v1/chat/completions` | Chat |
| `POST` | `/v1/responses` | Responses API (blocking + SSE streaming); volatile, see below |
| `GET` | `/v1/responses/{id}` | Retrieve a stored response |
| `DELETE` | `/v1/responses/{id}` | Delete a stored response |
| `GET` | `/v1/responses/{id}/input_items` | Paginate the original input items |
| `POST` | `/v1/embeddings` | Embeddings |
| `POST` | `/v1/audio/transcriptions` | Speech-to-text (source language) |
| `POST` | `/v1/audio/translations` | Speech-to-text **into English** (Whisper translate task) |
| `POST` | `/v1/images/generations` | Diffusion txt2img (blocking + SSE) |
| `POST` | `/v1/images/edits` | Diffusion img2img (multipart; blocking + SSE) |
| `POST` | `/v1/files` | Upload a file into the in-memory store (used by image URL responses + vector stores) |
| `GET` | `/v1/files` | List in-memory files |
| `GET` | `/v1/files/{id}` | File metadata |
| `GET` | `/v1/files/{id}/content` | Stream the bytes (used by image `response_format=url`) |

Other OpenAI routes may be added over time; this file is updated when they ship.

## `POST /v1/responses`

OpenAI-compatible Responses API: blocking, SSE streaming, retrieval by id,
and `previous_response_id` chaining. Backed by the same chat models registered
under `serve.models` (any alias whose endpoint category is `chat`).

> **Volatile state.** All responses are kept in process memory only — there is
> no disk or P2P persistence. Stored ids expire on server restart, after the
> per-entry TTL (1h by default), or once the LRU cap (256 entries) evicts
> them. Each response is also tagged with `X-QVAC-Stub: responses-volatile`
> and a one-line warn is logged at startup so operators know the surface is
> not durable. Pass `store: false` in the request body to skip persistence
> entirely.

Intentionally rejected with `400`: `conversation`, `background: true`, and
built-in tools (`web_search`, `file_search`, `code_interpreter`).
`function`-typed tools work normally.

### Examples

```bash
# Blocking
curl -sS http://127.0.0.1:11434/v1/responses \
  -H "Content-Type: application/json" \
  -d '{"model":"<alias>","input":"ping","store":true}'

# Streaming (SSE)
curl -sN http://127.0.0.1:11434/v1/responses \
  -H "Content-Type: application/json" \
  -d '{"model":"<alias>","input":"ping","stream":true}'

# Multi-turn via previous_response_id
curl -sS http://127.0.0.1:11434/v1/responses \
  -H "Content-Type: application/json" \
  -d '{"model":"<alias>","input":"and now?","previous_response_id":"resp_..."}'
```

## `POST /v1/images/generations` and `POST /v1/images/edits`

OpenAI-compatible image routes backed by the SDK's `diffusion()` primitive. The two endpoints share the same validation, response shape, and error model; `/v1/images/edits` adds a multipart-only `image` (init image, img2img) and an optional `strength`.

### Loaded model

Both routes require an alias whose **endpoint category** is `image`. Built-in SDK addons that resolve to this category are `diffusion` and `sdcpp-generation`. Register a diffusion model in `serve.models` and (typically) `preload: true`:

```json
{
  "serve": {
    "models": {
      "my-diffusion": {
        "model": "SD_V2_1_1B_Q8_0",
        "preload": true,
        "config": { "prediction": "v" }
      }
    }
  }
}
```

> **Drop-in for OpenAI image clients:** alias an OpenAI image-model name (e.g. `gpt-image-2`, `dall-e-2`) to your loaded diffusion model so client SDKs that hard-code the OpenAI name work without code change.

### Compatibility-driven hard fails

This server is intentionally **loud** about every OpenAI image-API field it cannot honor without producing the wrong bytes. Every case below is a `400` with a stable `error.code` so an agent can branch on it instead of silently shipping the wrong output to a user.

| HTTP | `error.code` | Trigger |
|------|--------------|---------|
| 400 | `mask_not_supported` | `/v1/images/edits` received a `mask` / `mask[]` field. The diffusion engine has no mask channel, so masked inpainting cannot be honored — it would silently re-render the entire image. Resend without `mask`. |
| 400 | `unsupported_response_format` | `response_format=url` was requested but the server is not configured with `--public-base-url` (no way to mint a downloadable URL — see below). Use `response_format=b64_json`. |
| 400 | `invalid_response_format` | Anything other than `b64_json` / `url`. |
| 400 | `unsupported_output_format` | `output_format` other than `png`. The server only emits PNG. |
| 400 | `unsupported_output_compression` | `output_compression` is set. Only meaningful with jpeg/webp, which we do not emit. |
| 400 | `unsupported_background` | `background=transparent|opaque|auto`. The server has no alpha-channel control. |
| 400 | `invalid_strength` | `/v1/images/edits` received a `strength` outside `[0, 1]` or a non-numeric value. |
| 400 | `missing_prompt` / `missing_model` / `missing_image` | Required fields absent. |
| 400 | `invalid_size` | `size` is not `"WIDTHxHEIGHT"` (multiples of 8) or `"auto"`. |
| 400 | `invalid_n` | `n` is not a positive integer. |
| 404 | `model_not_found` | Unknown alias. |
| 400 | `invalid_model_type` | Alias is not an `image` model. |
| 503 | `model_not_ready` | Model not loaded yet. |
| 500 | `image_generation_error` / `image_edit_error` | SDK / engine failure. |

The following OpenAI fields are **accepted and silently ignored** (a warning is logged) because they are advisory and would not change the bytes returned: `quality`, `style`, `moderation`, `partial_images`, `user`, `input_fidelity`.

### `response_format`: `b64_json` (default) or `url`

- **`b64_json`** (default) — `data[].b64_json` carries the inline base64 PNG. No server-side state.
- **`url`** — requires `--public-base-url <origin>` (or `serve.publicBaseUrl` in the config). The image is stored in the in-memory ephemeral files store (`purpose: "image_generation"`, `Content-Type: image/png`) and `data[].url` resolves to `${publicBaseUrl}/v1/files/{id}/content`. Each item also carries `expires_at` (Unix seconds) so clients know exactly when the URL stops working.

> **Caveat — URL mode + `--api-key`:** when bearer auth is enabled, `<img src="…">` cannot render the URL because browsers do not attach `Authorization` to image requests. Either run the server without `--api-key` for URL mode, or have the client fetch the bytes itself (`Authorization` header) and re-host them. Cleaner solutions (per-file URL tokens, presigned redirects) are tracked as follow-up.

### Streaming (`stream: true`)

Both routes support SSE streaming. The response is `text/event-stream` and emits one `image_generation.completed` event per generated image (always carrying inline `b64_json`, regardless of the requested `response_format`), then `[DONE]`.

> The SDK does not surface intermediate image bytes (only step ticks via `progressStream`), so we do not produce `image_generation.partial_image` events. This matches OpenAI's documented behavior for `partial_images: 0`.

### Ephemeral files store (used by URL responses)

Generated images live in process memory only — no disk, no P2P. Defaults: **1 h TTL**, **256 MB** total cap, **256 files** cap, oldest-first eviction. Every eviction logs a `warn` line with the reason (`ttl` / `max_files` / `max_bytes`) so operators can see when caps bite. `GET /v1/files/{id}/content` sets `Cache-Control: private, max-age=<seconds-until-eviction>` so downstream proxies cannot serve bytes the store has dropped.

### Examples

**`b64_json` (default), text-to-image:**

```bash
curl -sS http://127.0.0.1:11434/v1/images/generations \
  -H "Content-Type: application/json" \
  -d '{
    "model": "my-diffusion",
    "prompt": "a watercolor cat at golden hour",
    "size": "1024x1024",
    "n": 1
  }'
```

```json
{
  "created": 1718000000,
  "output_format": "png",
  "size": "1024x1024",
  "data": [{ "b64_json": "iVBORw0KGgoAAAANSUhEUgAA..." }]
}
```

**`url` mode (server started with `--public-base-url`):**

```bash
qvac serve openai --public-base-url "https://api.example.com"
```

```bash
curl -sS https://api.example.com/v1/images/generations \
  -H "Content-Type: application/json" \
  -d '{
    "model": "my-diffusion",
    "prompt": "a watercolor cat",
    "response_format": "url"
  }'
```

```json
{
  "created": 1718000000,
  "output_format": "png",
  "data": [
    {
      "url": "https://api.example.com/v1/files/file-abcd…/content",
      "expires_at": 1718003600
    }
  ]
}
```

**`/v1/images/edits` (img2img, multipart):**

```bash
curl -sS http://127.0.0.1:11434/v1/images/edits \
  -F "image=@input.png" \
  -F "model=my-diffusion" \
  -F "prompt=oil painting style, warm lighting" \
  -F "strength=0.65"
```

Response shape matches `/v1/images/generations`.

### Multipart edits — accepted fields

| Field | Description |
|-------|-------------|
| `image` (or `image[]`) | Source image file. **Required.** If multiple files are sent, only the first is used (warning logged). |
| `model`, `prompt` | Same as JSON variants. **Required.** |
| `size` | `"WIDTHxHEIGHT"` (multiples of 8) or `"auto"`. |
| `n` | Positive integer. |
| `seed` | Integer. |
| `strength` | SD/SDXL img2img strength in `[0, 1]`. Out-of-range or non-numeric → `400 invalid_strength`. |
| `response_format` | `b64_json` (default) or `url` (requires `--public-base-url`). |
| `stream` | When `true`, response is `text/event-stream` (see Streaming above). |

## `POST /v1/audio/translations`

OpenAI’s **translations** endpoint always returns **English text**. It maps to Whisper’s **translate** task (not “transcribe then run a text translator”).

### Request

- **Content-Type:** `multipart/form-data`
- **Fields:**
  - `file` (required) — audio file (same as transcriptions)
  - `model` (required) — must name a `serve.models` alias whose **endpoint category** is `audio-translation` (see below)
  - `prompt` (optional) — passed through to the SDK transcribe path (Whisper initial prompt where supported)
  - `response_format` (optional) — `json` (default) or `text`. `srt`, `vtt`, and `verbose_json` are not implemented yet.
- **Not supported:** `language`. Per-request language selection is not part of OpenAI’s translations API; output is always English. Use `/v1/audio/transcriptions` if you need non-English text.

### Registering a translation model (`whispercpp-audio-translation`)

Use the virtual SDK type **`whispercpp-audio-translation`** in `serve.models`. The CLI resolves it to the real engine **`whispercpp-transcription`** and **forces** `translate: true` on the **loadModel** `modelConfig` (Whisper translate-to-English). Nested `whisperConfig: { … }` in JSON is flattened into the top-level `modelConfig` for this alias so it matches what `@qvac/sdk` expects.

You may omit `translate`. If you set `translate: false` (top-level or under `whisperConfig`), it is **overridden to `true`** with a console warning.

The recommended shape is the same `"model": "<SDK_CONSTANT>"` shorthand used elsewhere in `serve.models`, with `type` set to the virtual translation type. The constant resolves to its registry `src`; `type` switches the alias from the constant's natural addon (`whispercpp-transcription`) to `whispercpp-audio-translation`.

**Minimal JSON — same weights as a transcription alias, second alias for translate:**

```json
{
  "serve": {
    "models": {
      "whisper-transcribe": { "model": "WHISPER_EN_TINY_Q8_0", "preload": true },
      "whisper-translate": {
        "model": "WHISPER_EN_TINY_Q8_0",
        "type": "whispercpp-audio-translation",
        "preload": true
      }
    }
  }
}
```

**Optional full `config`** uses the same **flat** Whisper keys as other `serve.models` Whisper entries (see [changelog example](./changelog/0.2.2/api.md): `language`, `n_threads`, `strategy`, … alongside `contextParams` / `miscConfig` if needed). You may also nest tuning under `whisperConfig`; for **`whispercpp-audio-translation` only**, those keys are merged to the top level before load.

**Example with extra Whisper tuning (flat keys, same style as transcriptions):**

```yaml
serve:
  models:
    whisper-1:
      model: WHISPER_EN_TINY_Q8_0
      type: whispercpp-audio-translation
      preload: true
      config:
        language: auto
        n_threads: 4
        strategy: greedy
        contextParams:
          use_gpu: true
        miscConfig:
          caption_enabled: false
```

If you need to point at non-registry weights (a local path, `https://…`, `registry://…`, etc.), drop the `model` shorthand and use the explicit `{ "type": "whispercpp-audio-translation", "src": "<weights>" }` form. `src` is passed to `@qvac/sdk` as `modelSrc` verbatim, so it cannot be an SDK constant name in that form — use the `model` shorthand above when you want constant resolution.

### Example (`curl`)

```bash
curl -s http://127.0.0.1:11434/v1/audio/translations \
  -F model=whisper-translate \
  -F file=@./sample.wav \
  -F response_format=json
```

Response (`json`): `{ "text": "..." }`  
Response (`text`): body is plain UTF-8 text.

### Same weights as transcriptions

You normally use the **same** underlying weights for both transcription and translation; register **two aliases** that share the same `"model": "WHISPER_…"` constant — one without `type` (defaults to transcription) and one with `type: "whispercpp-audio-translation"`.

### Errors

| HTTP | `error.code` | When |
|------|----------------|------|
| 400 | `invalid_content_type` | Not `multipart/form-data` |
| 400 | `missing_file` / `missing_model` | Required fields missing |
| 400 | `unsupported_param` | e.g. `language` present |
| 400 | `unsupported_response_format` | `srt`, `vtt`, `verbose_json` |
| 400 | `invalid_model_type` | Alias is not an `audio-translation` model (use `type: whispercpp-audio-translation` in `serve.models`) |
| 404 | `model_not_found` | Unknown alias |
| 503 | `model_not_ready` | Model not loaded yet |
| 500 | `translation_error` | SDK / engine failure |
