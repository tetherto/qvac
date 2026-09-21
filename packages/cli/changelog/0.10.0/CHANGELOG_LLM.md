# QVAC CLI v0.10.0 Release Notes

📦 **NPM:** https://www.npmjs.com/package/@qvac/cli/v/0.10.0

This release moves the CLI onto `@qvac/sdk` 0.17.0 and improves the OpenAI-compatible serve surface for transcription timing, companion model config, and completion-token accounting. It also removes the retired `ocr-onnx` plugin path in favor of `ggml-ocr`.

## Breaking Changes

### OCR plugin path

Serve configs and docs that still reference the retired ONNX OCR plugin must switch to the ggml OCR plugin.

**Before:**

```json
{ "plugins": ["@qvac/sdk/onnx-ocr/plugin"] }
```

**After:**

```json
{ "plugins": ["@qvac/sdk/ggml-ocr/plugin"] }
```

## New APIs

### Timed transcription response formats

`POST /v1/audio/transcriptions` now accepts OpenAI-compatible timed formats such as `vtt` and `srt`, in addition to plain text and JSON. Clients can request timed captions without a separate post-processing step:

```bash
curl -sS http://127.0.0.1:11434/v1/audio/transcriptions \
  -F model=whisper-transcribe \
  -F file=@./sample.wav \
  -F response_format=vtt
```

### Nested companion model constants in serve config

Serve model entries can resolve nested `*ModelSrc` constant names such as `s3genModelSrc` for multi-component TTS engines. Companion weights no longer need to be hard-coded as raw paths when the constant is already exported by the SDK:

```json
{
  "serve": {
    "models": {
      "chatterbox": {
        "model": "TTS_T3_TURBO_EN_CHATTERBOX_Q8_0",
        "type": "tts",
        "config": {
          "ttsEngine": "chatterbox",
          "language": "en",
          "s3genModelSrc": "TTS_S3GEN_EN_CHATTERBOX"
        }
      }
    }
  }
}
```

### Completion usage prefers emitted tokens

OpenAI-compatible chat usage now prefers `stats.emittedTokens` (non-empty pieces actually streamed to the client) when the addon reports it, while `generatedTokens` remains the decode-count signal for length and KV-cache budgeting. This keeps `usage.completion_tokens` aligned with what clients observe in the response stream.

## Dependency Alignment

`@qvac/cli` now depends on `@qvac/sdk@^0.17.0`. Publish and promote this release after `@qvac/sdk` 0.17.0 is on npm.

## Other

The package build now uses `tsc-alias` instead of the previous custom path-alias resolver.
