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
| `POST` | `/v1/embeddings` | Embeddings |
| `POST` | `/v1/audio/transcriptions` | Speech-to-text (source language) |
| `POST` | `/v1/audio/translations` | Speech-to-text **into English** (Whisper translate task) |

Other OpenAI routes may be added over time; this file is updated when they ship.

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

### The `src` field (same as everywhere else in `serve.models`)

For explicit entries, **`src` is passed to the SDK as `modelSrc`**. It is **not** limited to a hyperdrive or file path. Use whatever the SDK already accepts for Whisper loads: an **SDK model constant** name (e.g. `WHISPER_EN_TINY_Q8_0`), a `registry://…` descriptor, `https://…`, a local path, etc. — the same patterns as `qvac serve` models that use the `"model": "CONSTANT_NAME"` shorthand (that shorthand resolves to a `src` taken from the registry entry).

**Minimal JSON — same weights as a transcription alias, second alias for translate:**

```json
{
  "serve": {
    "models": {
      "whisper-transcribe": { "model": "WHISPER_EN_TINY_Q8_0", "preload": true },
      "whisper-translate": {
        "type": "whispercpp-audio-translation",
        "src": "WHISPER_EN_TINY_Q8_0",
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
      type: whispercpp-audio-translation
      src: WHISPER_EN_TINY_Q8_0
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

You normally use the **same** underlying weights for both transcription and translation; register **two aliases** (e.g. shorthand `"model": "WHISPER_…"` for `/v1/audio/transcriptions` and explicit `whispercpp-audio-translation` + the same `src` for `/v1/audio/translations`).

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
