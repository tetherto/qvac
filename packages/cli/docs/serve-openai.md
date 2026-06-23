# `qvac serve openai`

The CLI exposes an **OpenAI-compatible HTTP API** (`qvac serve openai`) so tools and SDKs that target OpenAI can run against local QVAC models.

This document describes the supported routes and how to configure `serve.models` for each capability. For general CLI usage, see [README.md](../README.md).

For the broader coding-agent stack — `@qvac/ai-sdk-provider`, managed `qvac serve`, `@qvac/opencode-plugin`, models.dev, layer ownership, and release choreography — see [Agent Integrations](../../../docs/architecture/AGENT-INTEGRATIONS.md). Use this file for CLI serve route/config details; use the agent integration reference when deciding whether behavior belongs in SDK, CLI, provider, plugin, docs, or models.dev.

## Implemented endpoints (today)

| Method | Path | Notes |
|--------|------|--------|
| `GET` | `/v1/models` | Lists **loaded** models |
| `GET` | `/v1/models/{id}` | Model metadata |
| `DELETE` | `/v1/models/{id}` | Unload |
| `POST` | `/v1/chat/completions` | Chat |
| `POST` | `/v1/completions` | Legacy text completions (single + multi-prompt; blocking + SSE) |
| `POST` | `/v1/responses` | Responses API (blocking + SSE streaming); volatile, see below |
| `GET` | `/v1/responses/{id}` | Retrieve a stored response |
| `DELETE` | `/v1/responses/{id}` | Delete a stored response |
| `GET` | `/v1/responses/{id}/input_items` | Paginate the original input items |
| `POST` | `/v1/embeddings` | Embeddings |
| `POST` | `/v1/audio/transcriptions` | Speech-to-text (source language) |
| `POST` | `/v1/audio/translations` | Speech-to-text **into English** (Whisper translate task) |
| `POST` | `/v1/audio/speech` | Text-to-speech (Chatterbox / Supertonic; `wav` + `pcm`, plus `mp3` / `opus` / `aac` / `flac` with `ffmpeg`) |
| `GET` | `/v1/audio/voices` | List configured TTS voices |
| `GET` | `/v1/audio/models` | List READY text-to-speech models |
| `POST` | `/v1/images/generations` | Diffusion txt2img (blocking + SSE) |
| `POST` | `/v1/images/edits` | Diffusion img2img (multipart; blocking + SSE) |
| `POST` | `/v1/videos` | Async video generation — txt2vid (JSON) or img2vid (JSON with `input_reference`); returns a queued job |
| `GET` | `/v1/videos` | List video generation jobs |
| `GET` | `/v1/videos/{id}` | Get video job status and progress |
| `GET` | `/v1/videos/{id}/content` | Download rendered video (`video/mp4` or `video/avi`) |
| `DELETE` | `/v1/videos/{id}` | Cancel and remove a video job |
| `POST` | `/v1/files` | Upload a file into the in-memory store (used by image URL responses + vector stores) |
| `GET` | `/v1/files` | List in-memory files |
| `GET` | `/v1/files/{id}` | File metadata |
| `GET` | `/v1/files/{id}/content` | Stream the bytes (used by image `response_format=url`) |
| `GET` | `/v1/vector_stores` | List vector stores |
| `POST` | `/v1/vector_stores` | Create a vector store |
| `GET` | `/v1/vector_stores/{id}` | Retrieve a vector store |
| `POST` | `/v1/vector_stores/{id}` | Update a vector store |
| `DELETE` | `/v1/vector_stores/{id}` | Delete a vector store |
| `POST` | `/v1/vector_stores/{id}/search` | Semantic search over a store (needs a loaded `embedding` model) |
| `POST` | `/v1/vector_stores/{id}/files` | Attach + embed a previously-uploaded file |

Other OpenAI routes may be added over time; this file is updated when they ship.

## `POST /v1/completions`

Legacy (pre-chat) OpenAI text-completions endpoint, kept for compatibility with
older OpenAI clients and SDKs that have not migrated to `/v1/chat/completions`.
Backed by the same chat-category models and SDK `completion` capability as
`/v1/chat/completions` — any alias registered with an endpoint category of
`chat` in `serve.models` serves both endpoints with no extra configuration.

> **Chat-template caveat.** The prompt is wrapped as a single `{ role: 'user' }`
> chat turn before being fed to the SDK, so the model's chat template (system
> prompt, role tags) still runs on every call. Legacy clients that expect raw
> OpenAI text-completion semantics (no system prompt, no role formatting around
> the prompt) will see template-shaped output. This is a deliberate
> compatibility trade-off — QVAC has one chat-category capability, not a
> raw-completion one. Use `/v1/chat/completions` directly if you need explicit
> control over the message structure.

### Prompt input

- **String prompt** — blocking JSON or SSE streaming. Response object is
  `text_completion` with `cmpl-` ids and `choices[0].text`.
- **Single-element string array** — same as a string prompt.
- **String array of length ≥ 2** (multi-prompt) — fanned out sequentially as
  N independent completions and returned in `choices` with matching `index`.
  Blocking only; combining with `"stream": true` returns
  `400 unsupported_streaming`. Any single prompt failing aborts the whole
  request — partial results are not emitted.
- **Token-id prompts** (`number[]`, `number[][]`) and **empty / missing
  prompts** — `400 invalid_prompt`.

### Examples

```bash
# Blocking, single prompt
curl -sS http://127.0.0.1:11434/v1/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"my-llm","prompt":"Say hello in one word.","max_tokens":16}'

# Streaming (single prompt only)
curl -sN http://127.0.0.1:11434/v1/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"my-llm","prompt":"Say hello in one word.","stream":true}'

# Multi-prompt fan-out (blocking only; stream:true returns 400)
curl -sS http://127.0.0.1:11434/v1/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"my-llm","prompt":["Reply with alpha.","Reply with beta."],"max_tokens":8}'
```

Blocking response shape (single prompt):

```json
{
  "id": "cmpl-…",
  "object": "text_completion",
  "created": 1718000000,
  "model": "my-llm",
  "choices": [
    { "text": "Hello", "index": 0, "logprobs": null, "finish_reason": "stop" }
  ],
  "usage": { "prompt_tokens": 0, "completion_tokens": 1, "total_tokens": 1 }
}
```

### Generation parameters

Same as `/v1/chat/completions`: `temperature`, `max_tokens`,
`max_completion_tokens`, `top_p`, `seed`, `frequency_penalty`,
`presence_penalty`, `reasoning_budget`.

### Ignored parameters (warning logged)

`logprobs`, `echo`, `best_of`, `suffix`, `stop`, `logit_bias`, `stream_options`,
`user`, `response_format`, and `n` when greater than `1`. Legacy OpenAI
semantics for these (logprob distributions, prompt echo, best-of-N sampling,
suffix insertion, multi-choice `n`) are not implemented.

### Errors

| HTTP | `error.code` | When |
|------|----------------|------|
| 400 | `invalid_json` | Body is not valid JSON |
| 400 | `missing_model` | `model` field is missing |
| 400 | `invalid_prompt` | Prompt is missing, empty, has empty array entries, or is provided as token ids |
| 400 | `unsupported_streaming` | Multi-prompt input combined with `"stream": true` |
| 400 | `invalid_model_type` | Alias is not a `chat` model |
| 404 | `model_not_found` | Unknown alias |
| 503 | `model_not_ready` | Model not loaded yet |
| 500 | `completion_error` | SDK / engine failure |

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

## `POST /v1/audio/speech`

OpenAI-compatible text-to-speech, backed by the SDK's `textToSpeech` capability (`@qvac/sdk` ONNX TTS — Chatterbox or Supertonic). Body is JSON, response body is binary audio.

### Loaded model

The route requires an alias whose **endpoint category** is `speech`. Built-in SDK addons that resolve to this category are `tts` and `onnx-tts`. Register a TTS model in `serve.models` with `preload: true` so the first request does not pay the cold-start tax.

```json
{
  "serve": {
    "models": {
      "my-tts": {
        "src": "registry://hf/ResembleAI/chatterbox-turbo-ONNX/resolve/<sha>/tokenizer.json",
        "type": "tts",
        "preload": true,
        "config": {
          "ttsEngine": "chatterbox",
          "language": "en",
          "ttsTokenizerSrc": "registry://hf/ResembleAI/chatterbox-turbo-ONNX/resolve/<sha>/tokenizer.json",
          "ttsSpeechEncoderSrc": "registry://hf/ResembleAI/chatterbox-turbo-ONNX/resolve/<sha>/onnx/speech_encoder.onnx",
          "ttsEmbedTokensSrc": "registry://hf/ResembleAI/chatterbox-turbo-ONNX/resolve/<sha>/onnx/embed_tokens.onnx",
          "ttsConditionalDecoderSrc": "registry://hf/ResembleAI/chatterbox-turbo-ONNX/resolve/<sha>/onnx/conditional_decoder.onnx",
          "ttsLanguageModelSrc": "registry://hf/ResembleAI/chatterbox-turbo-ONNX/resolve/<sha>/onnx/language_model.onnx",
          "referenceAudioSrc": "./voices/alloy-ref.wav"
        }
      }
    }
  }
}
```

> **Drop-in for OpenAI clients:** alias an OpenAI TTS model name (`tts-1`, `gpt-4o-mini-tts`, …) to your loaded TTS model so SDKs that hard-code the OpenAI name work without code change.

### Voice → model alias

OpenAI clients select a voice via the request `voice` field. QVAC TTS engines bind voice character to **load-time** config — Chatterbox uses **`referenceAudioSrc`** (a WAV path on disk); Supertonic uses **`ttsVoiceStyleSrc`** (and friends). There is no separate `voiceSrc` field on the wire — map each OpenAI voice to a model alias whose `config` carries the right paths.

The route resolves the backing model alias in this order:

1. **`serve.openai.audio.speech.voices[voice]`** — explicit map from an OpenAI voice string to a `serve.models` alias. Keys are matched **case-insensitively**. When this resolves to a loaded speech model, the request's `model` field is not used for routing (clients can still send a placeholder like `gpt-4o-mini-tts`).
2. **`serve.models[model + "-" + voice]`** — hyphen alias (e.g. `my-tts-alloy`).
3. **`serve.models[model]`** — bare model alias.
4. None of the above — `404 model_not_found`.

When `voice` is omitted, the configured **`serve.openai.audio.speech.defaultVoice`** is used (defaults to `"alloy"`). Set it to `null` to make `voice` strictly required (otherwise `400 missing_voice`).

### Example: voice map + multiple aliases

```json
{
  "serve": {
    "models": {
      "tts-chatter-alloy": {
        "src": "registry://hf/ResembleAI/chatterbox-turbo-ONNX/resolve/<sha>/tokenizer.json",
        "type": "tts",
        "preload": true,
        "config": { "ttsEngine": "chatterbox", "language": "en", "referenceAudioSrc": "./voices/alloy-ref.wav" }
      },
      "tts-chatter-echo": {
        "src": "registry://hf/ResembleAI/chatterbox-turbo-ONNX/resolve/<sha>/tokenizer.json",
        "type": "tts",
        "config": { "ttsEngine": "chatterbox", "language": "en", "referenceAudioSrc": "./voices/echo-ref.wav" }
      }
    },
    "openai": {
      "audio": {
        "speech": {
          "defaultVoice": "alloy",
          "voices": {
            "alloy": "tts-chatter-alloy",
            "echo": "tts-chatter-echo"
          }
        }
      }
    }
  }
}
```

### Request

- **Content-Type:** `application/json`
- **Fields:**
  - `model` (required) — alias, resolved as described above
  - `input` (required) — non-empty string, capped at **`serve.openai.audio.speech.maxInputChars`** (default **4096**, OpenAI's documented limit; set to `null` to disable)
  - `voice` (optional, defaults to `defaultVoice`)
  - `response_format` (optional) — `wav` (default), `pcm` (raw 16-bit signed little-endian PCM, mono), or `mp3` / `opus` / `aac` / `flac`. The encoded formats are produced by transcoding the synthesized audio through **`ffmpeg`**, which must be on the server's `PATH`; when ffmpeg is absent they return `503 transcode_unavailable` (use `wav`/`pcm` or install ffmpeg — see `qvac doctor`). The default stays `wav` so synthesis works on hosts without ffmpeg.
- **Accepted but ignored:** `speed`, `instructions`, `stream_format` (a warning is logged; ignored keys are echoed in the success response via the `X-QVAC-Ignored-Params` header).

### Response

Binary audio body. Headers include:

| Header | Description |
|--------|-------------|
| `Content-Type` | `audio/wav` (`wav`); **`audio/L16; rate=<sr>; channels=1`** (RFC 2586, `pcm`); `audio/mpeg` (`mp3`); `audio/ogg` (`opus`); `audio/aac` (`aac`); `audio/flac` (`flac`). |
| `Content-Length` | Total bytes. |
| `X-Audio-Sample-Rate` | Native sample rate of the model output. **24000** Hz for Chatterbox, **44100** Hz for Supertonic. Override by setting `sampleRate` on the alias's `config`. **Only sent for `wav`/`pcm`** — encoded containers carry their own rate metadata. |
| `X-Audio-Channels` | Always `1` (mono). Only sent for `wav`/`pcm`. |
| `X-Audio-Bits-Per-Sample` | Always `16`. Only sent for `wav`/`pcm`. |
| `X-QVAC-Ignored-Params` | Comma-separated list of accepted-but-dropped OpenAI fields (only present when at least one was sent). |

The route always **buffers the full audio** before responding (chunked HTTP streaming is tracked as a follow-up).

### Examples

**WAV (default), drop-in alias for OpenAI `tts-1`:**

```bash
curl -sS http://127.0.0.1:11434/v1/audio/speech \
  -H "Content-Type: application/json" \
  -d '{"model":"tts-1","voice":"alloy","input":"Hello from QVAC."}' \
  --output speech.wav
```

**Raw PCM (RFC 2586 `audio/L16`) — easier for in-process playback:**

```bash
curl -sS http://127.0.0.1:11434/v1/audio/speech \
  -H "Content-Type: application/json" \
  -d '{"model":"my-tts","voice":"echo","input":"PCM body.","response_format":"pcm"}' \
  --output speech.pcm
ffplay -f s16le -ar 24000 -ac 1 speech.pcm  # rate/channels come from the response headers
```

### Errors

| HTTP | `error.code` | When |
|------|--------------|------|
| 400 | `invalid_json` | Body is not valid JSON |
| 400 | `missing_model` | `model` field is missing |
| 400 | `missing_input` | `input` is missing or empty/whitespace |
| 400 | `input_too_long` | `input.length` exceeds `maxInputChars` (default 4096) |
| 400 | `missing_voice` | `voice` not sent and `defaultVoice` is `null` |
| 400 | `invalid_response_format` | Anything other than `wav` / `pcm` / `mp3` / `opus` / `aac` / `flac` |
| 400 | `invalid_model_type` | Alias is not a `speech` model |
| 404 | `model_not_found` | No `voices` mapping, no hyphen alias, no bare alias matches |
| 502 | `speech_empty` | The SDK returned zero samples — surfaced loudly so callers can distinguish "no audio" from "audio body" |
| 502 | `transcode_failed` | ffmpeg failed (or timed out) encoding `mp3` / `opus` / `aac` / `flac` — retry with `wav`/`pcm` |
| 503 | `transcode_unavailable` | `mp3` / `opus` / `aac` / `flac` requested but `ffmpeg` is not on the server's `PATH` |
| 503 | `model_not_ready` | Model not loaded yet |
| 500 | `speech_error` | SDK / engine failure (message goes to server logs only) |

## `GET /v1/audio/voices`

Lists the configured TTS voices — the OpenAI `voice` names mapped under **`serve.openai.audio.speech.voices`** plus the configured **`defaultVoice`**. Used by clients such as Open WebUI's voice selector. QVAC enforces no fixed voice catalog, so callers may also send any `voice` string that resolves via a `{model}-{voice}` alias.

The response carries both a flat `voices` array (consumed by Open WebUI) and an OpenAI-style `data` array. When no `voices` map is configured, the catalog is just the default voice (`"alloy"`).

```json
{
  "object": "list",
  "voices": ["alloy", "echo"],
  "data": [
    { "id": "alloy", "object": "audio.voice", "model": "tts-chatter-alloy" },
    { "id": "echo", "object": "audio.voice", "model": "tts-chatter-echo" }
  ]
}
```

## `GET /v1/audio/models`

Lists loaded (READY) text-to-speech models — the speech-capable subset of `/v1/models`, filtered to models whose endpoint category is `speech`. Same `{ object: "list", data: [...] }` shape as `/v1/models`, with each entry shaped like a `/v1/models` entry. Used by Open WebUI's TTS model selector.

```json
{
  "object": "list",
  "data": [
    { "id": "tts-chatter-alloy", "object": "model", "created": 1717200000, "owned_by": "qvac" }
  ]
}
```

## `POST /v1/videos` (and job lifecycle)

OpenAI-compatible **async** video surface backed by the SDK's `video()`. `POST`
creates a job and returns immediately with `status: "queued"`; generation runs
in the background. Poll `GET /v1/videos/{id}` until `status` is `completed` (or
`failed`), then fetch bytes from `GET /v1/videos/{id}/content`.

Requires an alias whose **endpoint category** is `video` (SDK addon
`sdcpp-video`). Register it in `serve.models`.

Two generation modes:

- **txt2vid** — JSON body with `prompt` only. No image required.
- **img2vid** — include `input_reference` in one of these forms:
  - **multipart file field** — send `multipart/form-data` with `input_reference` as a file field (this is what the OpenAI SDK sends when you pass a local `File`/`Blob`/`fs.ReadStream` as `Uploadable`)
  - **JSON `{ image_url }`** — base64 data URI (`data:image/jpeg;base64,...`) or an HTTP(S) URL (the server fetches it; 100 MB / 30 s limits apply)
  - **JSON `{ file_id }`** — ID of a file previously uploaded via `POST /v1/files`

  Mode is inferred from the presence of `input_reference`; no explicit `mode` field needed.
  `strength` (0–1) controls denoise intensity.

`/edits`, `/remix`, `/extensions`, and `/characters` are not implemented.

### Endpoints

| Method | Path | Notes |
|--------|------|-------|
| `POST` | `/v1/videos` | Create job → `{ status: "queued" }` |
| `GET` | `/v1/videos/{id}` | Poll status |
| `GET` | `/v1/videos/{id}/content` | Download; defaults to `video/mp4` (lazy ffmpeg transcode + cache). `?format=avi` returns the native MJPG-AVI. `?variant` other than `video` → `501 unsupported_variant` |
| `GET` | `/v1/videos` | Paginated list (`limit` / `order` / `after`) |
| `DELETE` | `/v1/videos/{id}` | Abort the running job and drop its assets |

### Deviations from the OpenAI spec

- `size` accepts any `WxH` (multiples of 16) in addition to OpenAI's 4-value enum.
- `Content-Type: video/mp4` is produced by a server-side ffmpeg transcode; `?format=avi` returns the native container.
- The list endpoint is **in-memory only** — a restart clears it.
- HTTP(S) URL fetches for `input_reference.image_url` are capped at 100 MB and 30 s.

### Errors

| HTTP | `error.code` | When |
|------|--------------|------|
| 400 | `invalid_input_reference` | Data URI has invalid base64, decodes to empty bytes, or is missing the comma separator; HTTP(S) URL returned non-200, timed out, or exceeded the 100 MB limit; `file_id` not found |
| 400 | `invalid_strength` | `strength` outside `[0, 1]` or non-numeric |
| 400 | `invalid_model_type` | Alias is not a `video` model |
| 404 | `video_not_found` | Unknown job id |
| 501 | `unsupported_variant` | `GET …/content?variant=` other than `video` |
| 503 | `model_not_ready` | Model not loaded yet |
