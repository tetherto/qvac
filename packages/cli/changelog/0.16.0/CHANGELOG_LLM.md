# QVAC CLI v0.16.0 Release Notes

📦 **NPM:** https://www.npmjs.com/package/@qvac/cli/v/0.16.0

QVAC CLI 0.16.0 depends on `@qvac/sdk@0.22.0`. `qvac serve` can prove it holds the API key before a client sends it, mount System One decisions at `/v1/systemone`, keep nested JSON Schema on tools, replay past tool calls as structured history, and default `parallel_tool_calls` to true on tool requests. Loads pick a per-alias `modelFitPolicy` and an ordered GPU backend list. Bundling needs Node `^22.21.0 || >=24.9.0`.

Install `@qvac/cli@0.16.0` with `@qvac/sdk@^0.22.0`. The committed range is `^0.22.0`.

## Breaking Changes

### Node version for `qvac bundle` / bare-pack

bare-pack needs Node `^22.21.0 || >=24.9.0`. Earlier 22.x (including 22.20.0) crashes the lexer. `qvac doctor` and `qvac bundle` refuse those versions instead of native-crashing.

**Before:**

```json
"engines": { "node": ">=18.0.0" }
```

```text
$ node --version
v22.20.0
$ qvac doctor
  ✅ Node.js version — v22.20.0
$ qvac bundle sdk
  bare-pack exited with code 134
```

**After:**

```json
"engines": { "node": "^22.21.0 || >=24.9.0" }
```

```text
$ qvac doctor
  ❌ Node.js version — v22.20.0
      Upgrade Node.js to ^22.21.0 || >=24.9.0 (current: v22.20.0); bundling needs Node 22.21+ on the 22 line or 24.9+.
$ qvac bundle sdk
  ❌ Bundler Error:
     bare-pack needs Node ^22.21.0 || >=24.9.0; found Node v22.20.0. Upgrade Node and run the bundle again.
```

### Per-alias `modelFitPolicy`

Skipping the fit probe was process-wide (`QVAC_ADVISORY_MODEL_FIT=0`) and also disabled the engine verdict for fit assessment. The probe is now per load. `'log'` (default) still runs it and never blocks. `'off'` skips it for that alias only. `'refuse'` fails a load the engine projects will not fit.

**Before:**

```text
QVAC_ADVISORY_MODEL_FIT=0
```

**After:**

```json
{
  "serve": {
    "models": {
      "big": {
        "model": "GPT_OSS_20B_INST_Q4_K_M",
        "modelFitPolicy": "refuse",
        "config": {
          "ctx_size": 131072,
          "cache-type-k": "f32",
          "cache-type-v": "f32"
        }
      }
    }
  }
}
```

### Cached turns send the full conversation

Named KV-cache completions on `qvac serve` send the whole history every turn. `remove_thinking_from_context` is no longer honored on `/v1/chat/completions`, `/v1/completions`, or `/v1/responses`. A changed tool set on a named key reuses the same cache file, trimmed where it differs. A deleted attachment now fails later cached turns, as it does uncached. `stats.promptTokens` on a cached turn counts only the tokens processed that turn; reused cache tokens are excluded.

## New APIs

### Nested JSON Schema on tool parameters

`POST /v1/chat/completions` and `POST /v1/responses` keep nested JSON Schema on tool parameters, including arrays of objects and union types.

```bash
curl -sS http://127.0.0.1:11434/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "<alias>",
    "messages": [{"role": "user", "content": "Plan a trip"}],
    "tools": [{
      "type": "function",
      "function": {
        "name": "plan_trip",
        "description": "Plan a trip",
        "parameters": {
          "type": "object",
          "properties": {
            "stops": {
              "type": "array",
              "items": {"type": "object", "properties": {"name": {"type": "string"}}}
            },
            "budget": {"type": ["number", "null"]}
          },
          "required": ["stops"]
        }
      }
    }]
  }'
```

### Past tool calls as structured history

Assistant `tool_calls` and following `tool` messages are forwarded as structured history, so the chat template can render them in its own tool-call format.

```bash
curl -sS http://127.0.0.1:11434/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "<alias>",
    "messages": [
      {"role": "user", "content": "Weather in Paris?"},
      {
        "role": "assistant",
        "content": "",
        "tool_calls": [{
          "id": "call_1",
          "type": "function",
          "function": {"name": "get_weather", "arguments": "{\"city\":\"Paris\"}"}
        }]
      },
      {"role": "tool", "tool_call_id": "call_1", "content": "18C"}
    ],
    "tools": [{
      "type": "function",
      "function": {
        "name": "get_weather",
        "parameters": {"type": "object", "properties": {"city": {"type": "string"}}}
      }
    }]
  }'
```

### System One HTTP

`qvac configure` can add a decision alias (`LAYA_MULTILINGUAL_322M_Q8_0`). `qvac serve --systemone` mounts `POST /v1/systemone` for typed choice, score, or noul questions about one state.

```bash
qvac serve --systemone
```

```json
{
  "serve": {
    "models": {
      "laya": {
        "model": "LAYA_MULTILINGUAL_322M_Q8_0",
        "type": "llamacpp-decision",
        "config": { "device": "cpu" }
      }
    }
  }
}
```

```bash
curl -sS http://127.0.0.1:11434/v1/systemone \
  -H "Content-Type: application/json" \
  -d '{
    "model": "laya",
    "state": "Please refund my duplicate payment.",
    "questions": {
      "refund": { "type": "noul", "instructions": "A refund is requested." }
    }
  }'
```

### MOSS ASR and Nemotron diarization

`qvac serve --openai` transcribes MOSS diarize checkpoints on `/v1/audio/transcriptions`. Multipart `hotwords` and `max_new_tokens` are accepted on MOSS only. Nemotron Sortformer diarization on a Parakeet load returns overlapping speaker segments.

```json
{
  "serve": {
    "models": {
      "moss": { "model": "MOSS_TRANSCRIBE_DIARIZE_Q8_0" },
      "nemotron": {
        "src": "./nemotron-diarization.gguf",
        "type": "parakeet-transcription"
      }
    }
  }
}
```

```bash
curl -sS http://127.0.0.1:11434/v1/audio/transcriptions \
  -F model=moss \
  -F file=@meeting.wav \
  -F 'hotwords=["Erin"]'
```

### MOSS TTS 0.11 engines

`qvac configure` adds `moss-sfx` (sound effects from `AUDIOGEN_MOSS_SFX_V2_Q8_0`) and `moss-speech` (spoken replies from `TTS_MOSS_SPEECH_Q8_0` plus `TTS_CODEC_MOSS_SPEECH_F16`). `POST /v1/audio/speech` uses that load config.

```json
{
  "serve": {
    "models": {
      "sfx": {
        "src": "AUDIOGEN_MOSS_SFX_V2_Q8_0",
        "type": "tts",
        "config": { "ttsEngine": "moss-sfx" }
      }
    }
  }
}
```

### GPU backend selection for LLM, embeddings, and VLA

LLM, embedding, and VLA aliases can name an ordered GPU backend list in `serve.models[].config.backend`. Unset uses the native default order. Use `device: "cpu"` for CPU.

```json
{
  "serve": {
    "models": {
      "chat": {
        "model": "QWEN3_600M_INST_Q4",
        "config": { "backend": ["cuda", "vulkan"] }
      }
    }
  }
}
```

`qvac configure` accepts the same list as `cuda,vulkan`.

### Serve identity before sending the key

`qvac serve --port 0 --ready-fd <fd>` writes `QVAC_SERVE_READY {"port":…,"pid":…}` on an inherited descriptor (≥ 3) once listening. Clients can then `GET /qvac/identity?nonce=` (22–128 unpadded base64url characters) without auth. The proof is HMAC-SHA256 of `qvac-serve-identity-v1\n<port>\n<nonce>` with the serve key, so a supervisor can confirm the listener holds the key before sending it.

```bash
qvac serve --openai --api-key-file key --port 0 --ready-fd 3
# fd 3: QVAC_SERVE_READY {"port":53127,"pid":4242}

curl "http://127.0.0.1:53127/qvac/identity?nonce=$NONCE"
# {"proof":"<base64url HMAC-SHA256(key, \"qvac-serve-identity-v1\\n53127\\n$NONCE\")>"}
```

### Forward `parallel_tool_calls`

`POST /v1/chat/completions` and `POST /v1/responses` requests with `tools` pass `parallel_tool_calls` to the SDK, defaulting to `true`. Requests without tools are unchanged. The SDK's own default is one call per response, so an OpenAI client that never sets the field used to get at most one.

```bash
curl -sS http://127.0.0.1:11434/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "<alias>",
    "messages": [{"role": "user", "content": "Weather in Paris and London?"}],
    "tools": [{
      "type": "function",
      "function": {
        "name": "get_weather",
        "parameters": {"type": "object", "properties": {"city": {"type": "string"}}}
      }
    }],
    "parallel_tool_calls": false
  }'
```

## Bug Fixes

`POST /qvac/v1/translate` still rejects a `text` array over 100 items after the zod 4.6.6 bump, instead of letting the batch cap fall off the schema.

Registry engine classification stays consistent, so `qvac configure` and `qvac serve` pick the same engine for a catalog entry.

## Model Changes

### Added

```
MOSS_TRANSCRIBE_DIARIZE_F16
MOSS_TRANSCRIBE_DIARIZE_Q5_0
MOSS_TRANSCRIBE_DIARIZE_Q8_0
PARAKEET_NEMOTRON_3_DIARIZATION_Q8_0
```
