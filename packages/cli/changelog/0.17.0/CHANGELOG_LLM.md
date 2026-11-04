# QVAC CLI v0.17.0 Release Notes

📦 **NPM:** https://www.npmjs.com/package/@qvac/cli/v/0.17.0

QVAC CLI 0.17.0 depends on `@qvac/sdk@^0.22.0`, the same SDK line as 0.16.0. Decision models move from `--systemone` to an OpenAI-style `POST /v1/decisions` endpoint under `--openai`, and `qvac serve` now checks the `Host` header of every request. The QVAC surface reports host resources and model fit and runs batch chat completion, `/v1/audio/speech` can stream over SSE, and `/v1/videos` no longer fetches image URLs on private networks.

## Breaking Changes

### `--systemone` is replaced by `POST /v1/decisions`

`--systemone` and `POST /v1/systemone` are removed. Decision aliases are served by `qvac serve --openai` at `POST /v1/decisions`. Questions are an ordered array instead of an object keyed by ID, and `noul` questions become `predicate` questions.

**Before:**

```bash
qvac serve --systemone
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

**After:**

```bash
qvac serve --openai
curl -sS http://127.0.0.1:11434/v1/decisions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "laya",
    "input": "Please refund my duplicate payment.",
    "questions": [
      { "type": "predicate", "name": "refund", "instructions": "A refund is requested." }
    ]
  }'
```

### Host header check on `qvac serve`

A page that rebinds its own domain to `127.0.0.1` could read `/openapi.json` and call the server, because CORS does not apply to a same-origin request. Every request now needs a `Host` that names a loopback host, an IP address, the bind host, the `--public-base-url` host or an allowed host. Anything else gets `403 host_not_allowed`. The port is ignored.

Clients that dial `localhost`, `127.0.0.1`, `[::1]`, any IP address or the exact `--host` value are unaffected. A server reached by another hostname must allow that name.

**Before:**

```bash
qvac serve --openai --host 0.0.0.0 --api-key-file ./key
curl -H 'Authorization: Bearer …' http://gpu-box.lan:11434/v1/models   # 200
```

**After:**

```bash
qvac serve --openai --host 0.0.0.0 --api-key-file ./key --allowed-host gpu-box.lan
curl -H 'Authorization: Bearer …' http://gpu-box.lan:11434/v1/models   # 200; 403 host_not_allowed without --allowed-host
```

## New APIs

### OpenAI Decisions endpoint

`POST /v1/decisions` answers predicate, choice and score questions with a configured local decision model. Input is text or a conversation. Answers keep the order of the questions, typed choice values and optional names. The response carries OpenAI-style token usage. The endpoint returns complete JSON; streaming, batch inputs, images and prompt caching are unsupported.

```bash
qvac configure --modality decision
qvac serve --openai
```

```bash
curl http://127.0.0.1:11434/v1/decisions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "laya-multilingual-322m-q8-0",
    "input": "Charged twice",
    "questions": [{
      "type": "predicate",
      "name": "urgent",
      "instructions": "Does this need immediate attention?"
    }]
  }'
```

### Allowed hosts

`--allowed-host <host>` is repeatable; a leading dot (`.corp.example`) covers subdomains. `serve.allowedHosts` sets the same list in config. `--allow-any-host`, or `"allowedHosts": true`, turns the check off.

```bash
qvac serve --openai --allowed-host qvac.internal --allowed-host .corp.example
qvac serve --openai --allow-any-host
```

```json
{ "serve": { "allowedHosts": ["qvac.internal"] } }
```

### System resources and model fit

`GET /qvac/v1/system` reports the host's CPU, memory and GPUs; `?sample=true` adds current load and memory use. `POST /qvac/v1/models/fit` asks whether up to 16 models are likely to fit before loading them. Nothing is downloaded or loaded. An alias is assessed with the config it would load with, and `modelConfig` in the request is merged over it. The verdict is advisory: `likely-fits`, `likely-too-large` or `unknown`.

```bash
curl -sS "http://localhost:11434/qvac/v1/system?sample=true"

curl -sS http://localhost:11434/qvac/v1/models/fit \
  -H "Content-Type: application/json" \
  -d '{"models":[{"model":"my-llm","modelConfig":{"ctx_size":8192}}]}'
```

### Batch chat completion

`POST /qvac/v1/chat/batch` runs up to 64 chat prompts through one loaded LLM in a single request; the model decodes them together. Each prompt takes the `/v1/chat/completions` request fields, and results come back in prompt order with batch-level `stats`. The alias needs `config.parallel` of 2 or more, otherwise the request returns `400 batch_not_enabled`.

```bash
curl http://localhost:11434/qvac/v1/chat/batch \
  -H "Content-Type: application/json" \
  -d '{"model":"my-llm","prompts":[
        {"id":"a","messages":[{"role":"user","content":"Reply with only the word CHERRY."}]},
        {"id":"b","messages":[{"role":"user","content":"Reply with only the word BANANA."}]}]}'
```

### Streaming speech

`POST /v1/audio/speech` with `stream_format: "sse"` streams `speech.audio.delta` events, one per synthesized sentence, and ends with `speech.audio.done`. It supports `pcm` and `wav`. Encoded formats return `400 unsupported_response_format`, and MOSS-SoundEffect and MOSS-Speech aliases return `400 unsupported_stream_format`. The default `stream_format: "audio"` still returns one body.

```bash
curl -N http://localhost:11434/v1/audio/speech -H "Content-Type: application/json" \
  -d '{"model":"my-tts","input":"Hello.","response_format":"pcm","stream_format":"sse"}'
```

## Bug Fixes

### Video image URLs on private networks

`POST /v1/videos` fetched `input_reference.image_url` from any address, so a caller could make the server connect to loopback, private, link-local or cloud-metadata hosts. The server now fetches only public hosts. It checks every resolved address and every redirect hop. Every fetch failure except the 100 MB limit returns the same message. Data URIs, `file_id` and public HTTP(S) URLs work as before.

### Endpoint categories for image-generation aliases

Every `sdcpp-generation` alias was accepted by `/v1/images/*`, including upscaler and world-mode aliases. The category now comes from `config.mode`: `diffusion` (the default) is `image`, and `video`, `upscale` and `world` are their own categories. A route given an alias of another category returns `400 invalid_model_type`, and an unknown `mode` fails at startup.
