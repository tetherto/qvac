# 🔌 API Changes v0.10.0

## Add timed audio transcription response formats

PR: [#3500](https://github.com/tetherto/qvac/pull/3500)

```bash
curl -sS http://127.0.0.1:11434/v1/audio/transcriptions \
  -F model=whisper-transcribe \
  -F file=@./sample.wav \
  -F response_format=vtt
```

---

## Resolve nested *ModelSrc constant names in serve config

PR: [#3572](https://github.com/tetherto/qvac/pull/3572)

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

---

## Count emitted tokens for usage, keep decode count for length

PR: [#3573](https://github.com/tetherto/qvac/pull/3573)

```typescript
const stats = await result.stats
// Decode count — length / KV-cache budget decisions
stats?.generatedTokens
// Addon-streamed non-empty pieces — prefer for OpenAI usage accounting
stats?.emittedTokens

// Serve usage prefers emittedTokens when present:
// usage.completion_tokens === stats.emittedTokens ?? stats.generatedTokens
```

---
