# 🔌 API Changes v0.2.0

## Add OpenAI-compatible REST API server (qvac serve) - Part I

PR: [#753](https://github.com/tetherto/qvac/pull/753)

```
src/serve/
├── index.ts                  # HTTP server, middleware, adapter dispatch
├── config.ts                 # Config parsing, model constant resolution
├── http.ts                   # HTTP/SSE helpers
├── core/
│   ├── sdk.ts                # SDK wrapper (dynamic import + version check)
│   ├── model-registry.ts     # In-memory model state tracking
│   └── lifecycle.ts          # Model preload/load/unload/shutdown
└── adapters/
    ├── types.ts              # APIAdapter interface
    └── openai/
        ├── index.ts          # OpenAI adapter entry
        ├── translate.ts      # Message/tool format translation
        └── routes/
            ├── models.ts
            ├── chat.ts
            └── embeddings.ts
```

```
@qvac/sdk 0.6.0 is too old for this version of @qvac/cli.
Minimum required: 0.7.0. Run: npm install @qvac/sdk@latest
```

```json
{
  "serve": {
    "models": {
      "llm": { "model": "QWEN3_600M_INST_Q4", "config": { "ctx_size": 8192 } },
      "embed": "EMBEDDINGGEMMA_300M_Q4_0"
    }
  }
}
```

```
qvac serve openai [options]
  -c, --config <path>    Config file path
  -p, --port <number>    Port (default: 11434)
  -H, --host <address>   Host (default: 127.0.0.1)
  --model <alias>        Model to preload (repeatable)
  --api-key <key>        Require Bearer token auth
  --cors                 Enable CORS headers
  -v, --verbose          Detailed output
```

---

## Add POST /v1/audio/transcriptions to qvac serve OpenAI adapter

PR: [#915](https://github.com/tetherto/qvac/pull/915)

```bash
# JSON response (default)
curl -s http://127.0.0.1:11434/v1/audio/transcriptions \
  -F "file=@audio.wav" \
  -F "model=whisper-large-v3-turbo" \
  -F "response_format=json" | jq .
# → {"text": "transcribed text here"}

# Plain text response
curl -s http://127.0.0.1:11434/v1/audio/transcriptions \
  -F "file=@audio.wav" \
  -F "model=whisper-small-en" \
  -F "response_format=text"
# → transcribed text here
```

```json
{
  "serve": {
    "models": {
      "qwen3-0.6b": {
        "model": "QWEN3_600M_INST_Q4",
        "default": true,
        "preload": false,
        "config": { "tools": true }
      },
      "gte-large": {
        "model": "GTE_LARGE_FP16",
        "default": true,
        "preload": false
      },
      "whisper": {
        "model": "WHISPER_TINY",
        "default": true,
        "preload": true,
        "config": {
          "audio_format": "f32le",
          "language": "en",
          "strategy": "greedy",
          "n_threads": 4,
          "suppress_blank": true,
          "contextParams": { "use_gpu": true }
        }
      }
    }
  }
}

```

```bash
#!/usr/bin/env bash
# Test transcription endpoint against a running qvac serve instance
# Usage: ./test-transcription.sh [audio-file]
#
# Setup:
#   bun run download-sample   # downloads samples/jfk.wav
#   bun run serve              # start server in another terminal

set -euo pipefail

BASE="http://127.0.0.1:11434"
AUDIO="${1:-samples/jfk.wav}"

if [ ! -f "$AUDIO" ]; then
  echo "Audio file not found: $AUDIO"
  echo "Run: bun run download-sample"
  exit 1
fi

echo "=== Using audio: $AUDIO ($(du -h "$AUDIO" | cut -f1) ) ==="
echo ""

# ── 1. JSON response (default) ──────────────────────────────
echo "── 1. Transcribe → JSON response ──"
curl -s "$BASE/v1/audio/transcriptions" \
  -F "file=@$AUDIO" \
  -F "model=whisper" | jq .
echo ""

# ── 2. Text response ────────────────────────────────────────
echo "── 2. Transcribe → text response ──"
curl -s "$BASE/v1/audio/transcriptions" \
  -F "file=@$AUDIO" \
  -F "model=whisper" \
  -F "response_format=text"
echo ""
echo ""

# ── 3. With prompt ───────────────────────────────────────────
echo "── 3. Transcribe → with prompt ──"
curl -s "$BASE/v1/audio/transcriptions" \
  -F "file=@$AUDIO" \
  -F "model=whisper" \
  -F "prompt=President Kennedy speech about space exploration" | jq .
echo ""

# ── 4. Explicit json response_format ────────────────────────
echo "── 4. Transcribe → explicit response_format=json ──"
curl -s "$BASE/v1/audio/transcriptions" \
  -F "file=@$AUDIO" \
  -F "model=whisper" \
  -F "response_format=json" | jq .
echo ""

# ── Error cases ──────────────────────────────────────────────

echo "── 5. Error: missing file ──"
curl -s "$BASE/v1/audio/transcriptions" \
  -F "model=whisper" | jq .
echo ""

echo "── 6. Error: missing model ──"
curl -s "$BASE/v1/audio/transcriptions" \
  -F "file=@$AUDIO" | jq .
echo ""

echo "── 7. Error: unsupported response_format (srt) ──"
curl -s "$BASE/v1/audio/transcriptions" \
  -F "file=@$AUDIO" \
  -F "model=whisper" \
  -F "response_format=srt" | jq .
echo ""

echo "── 8. Error: unknown model ──"
curl -s "$BASE/v1/audio/transcriptions" \
  -F "file=@$AUDIO" \
  -F "model=nonexistent" | jq .
echo ""

echo "── 9. Error: wrong content-type (JSON instead of multipart) ──"
curl -s "$BASE/v1/audio/transcriptions" \
  -H "Content-Type: application/json" \
  -d '{"model":"whisper-large-v3-turbo"}' | jq .
echo ""

echo "=== Done ==="

```

---

