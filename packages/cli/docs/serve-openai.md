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

Use the virtual SDK type **`whispercpp-audio-translation`** in `serve.models`. The CLI resolves it to the real engine **`whispercpp-transcription`** and **forces** `whisperConfig.translate: true` at config parse time (so the loaded Whisper model runs in translate-to-English mode).

You may omit `translate` in config. If you set `translate: false`, it is **overridden to `true`** with a console warning — a `whispercpp-audio-translation` alias would otherwise contradict its purpose.

**Minimal YAML (`qvac.config.yaml`):**

```yaml
serve:
  models:
    whisper-1:
      type: whispercpp-audio-translation
      src: hyper://your-hyperdrive/whisper-tiny.en.gguf
      preload: true
      config:
        whisperConfig:
          language: auto
          n_threads: 4
        contextParams:
          model: hyper://your-hyperdrive/whisper-tiny.en.gguf
          use_gpu: true
        miscConfig:
          caption_enabled: false
```

**Minimal JSON (`qvac.config.json`):**

```json
{
  "serve": {
    "models": {
      "whisper-1": {
        "type": "whispercpp-audio-translation",
        "src": "hyper://your-hyperdrive/whisper-tiny.en.gguf",
        "preload": true,
        "config": {
          "whisperConfig": { "language": "auto", "n_threads": 4 },
          "contextParams": { "model": "hyper://your-hyperdrive/whisper-tiny.en.gguf", "use_gpu": true },
          "miscConfig": { "caption_enabled": false }
        }
      }
    }
  }
}
```

### Example (`curl`)

```bash
curl -s http://127.0.0.1:11434/v1/audio/translations \
  -F model=whisper-1 \
  -F file=@./sample.wav \
  -F response_format=json
```

Response (`json`): `{ "text": "..." }`  
Response (`text`): body is plain UTF-8 text.

### Same weights as transcriptions

You normally use the **same** Whisper weights for both `whispercpp-transcription` (transcriptions) and `whispercpp-audio-translation` (translations); register **two aliases** pointing at the same `src` if you want both `/v1/audio/transcriptions` and `/v1/audio/translations` available.

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
