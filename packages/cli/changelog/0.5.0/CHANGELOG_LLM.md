# Changelog v0.5.0

Release Date: 2026-05-15

📦 **NPM:** https://www.npmjs.com/package/@qvac/cli/v/0.5.0

This release fills out the OpenAI-compatible HTTP server (`qvac serve openai`) with the routes most agent stacks expect (audio speech / translations, vector stores, legacy `/v1/completions`, the OpenAI Responses surface, `images/edits`) and wires the CLI into the new SDK 0.11.0 cancel surface so client disconnects actually cancel the underlying inference. Two surfaces tighten loud-fail behaviour: image routes now reject unsupported parameters with stable `error.code` instead of silently producing the wrong bytes, and the SDK removes two legacy `cancel(...)` shapes that couldn't be back-mapped onto the new `requestId` envelope.

---

## 🔌 New APIs

### `POST /v1/audio/speech` on `qvac serve openai`

The OpenAI-compatible HTTP server now exposes text-to-speech, backed by the SDK `tts()` primitive. Configure a TTS model and call the endpoint with a JSON body matching the OpenAI shape:

```bash
# Synthesize wav (default)
curl http://localhost:11434/v1/audio/speech \
  -H "Content-Type: application/json" \
  -d '{"model":"my-tts","voice":"alloy","input":"QVAC SDK is the canonical entry point to QVAC."}' \
  --output speech.wav

# Synthesize raw pcm
curl http://localhost:11434/v1/audio/speech \
  -H "Content-Type: application/json" \
  -d '{"model":"my-tts","voice":"alloy","input":"hello","response_format":"pcm"}' \
  --output speech.pcm
```

The `voice` parameter is accepted-and-ignored (the underlying engine is voice-fixed); `response_format` accepts `wav` (default) and `pcm`.

### `POST /v1/audio/translations` on `qvac serve openai`

Audio-to-English translation, distinct from `/v1/audio/transcriptions`. Configure a Whisper model with `type: "whispercpp-audio-translation"`; the same underlying model can serve both transcription and translation endpoints if both are configured separately:

```json
// qvac.config.json
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

```bash
curl -s http://127.0.0.1:11434/v1/audio/translations \
  -F model=whisper-translate \
  -F file=@./sample.wav \
  -F response_format=json
# => { "text": "..." }   (always English)
```

### `/v1/vector_stores` cluster on `qvac serve openai`

The OpenAI vector-store surface (create / list / get / delete vector store, upload / list / get / delete file, attach file to store, search store) is now served against the SDK RAG primitives. Files uploaded via `POST /v1/files` are kept in an in-memory ephemeral store until they're attached to a vector store, at which point the bytes are run through `ragIngest` and dropped:

```bash
# 1. Create a vector store (synthetic; no workspace materialized yet)
curl http://localhost:11434/v1/vector_stores \
  -H "Content-Type: application/json" \
  -d '{ "name": "product-docs" }'

# 2. Upload a file (multipart, bytes kept in memory until attached)
curl http://localhost:11434/v1/files \
  -F "file=@./notes.txt;type=text/plain" \
  -F "purpose=assistants"

# 3. Attach the file to the store (runs ragIngest, drops the bytes)
curl http://localhost:11434/v1/vector_stores/vs_abc123/files \
  -H "Content-Type: application/json" \
  -d '{ "file_id": "file-abc..." }'

# 4. Search the store
curl http://localhost:11434/v1/vector_stores/vs_abc123/search \
  -H "Content-Type: application/json" \
  -d '{ "query": "How do I configure preload?", "max_num_results": 5 }'
```

A loaded LLM is required to back vector store creation (it's the embedding-model anchor); a dedicated embedding model is required for ingest/search. The route table and error codes (`file_not_found`, `missing_file_id`, `vector_store_not_found`, etc.) are documented in `packages/cli/docs/serve-openai.md`.

### `POST /v1/completions` on `qvac serve openai` (legacy text-completion surface)

Adds the OpenAI legacy `/v1/completions` route (single-prompt or array-of-prompt input, blocking or streaming for single-prompt only). Targets clients that haven't moved to chat-completions yet:

```bash
# blocking
curl http://localhost:11434/v1/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "my-llm",
    "prompt": "Say hello in one word.",
    "max_tokens": 16
  }'

# streaming (single prompt only)
curl -N http://localhost:11434/v1/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "my-llm",
    "prompt": "Say hello in one word.",
    "stream": true
  }'

# multi-prompt (blocking only; stream:true returns 400)
curl http://localhost:11434/v1/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "my-llm",
    "prompt": ["Reply with alpha.", "Reply with beta."],
    "max_tokens": 8
  }'
```

Response shape matches OpenAI's `text_completion` object; multi-prompt requests return one `choices[]` entry per prompt.

### `/v1/responses` (OpenAI Responses surface) with in-memory store

Adds the OpenAI Responses cluster — `POST /v1/responses` (create, blocking or streaming), `GET /v1/responses/{id}`, `DELETE /v1/responses/{id}` — backed by an in-memory store keyed by response id. Supports `previous_response_id` chaining for follow-up turns:

```bash
# Blocking create
curl -sS "$BASE/v1/responses" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"model":"'"$MODEL"'","input":"ping","store":true}'

# Streaming
curl -sN "$BASE/v1/responses" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"model":"'"$MODEL"'","input":"ping","stream":true,"store":true}'

# Chained follow-up (after capturing response id from prior call)
curl -sS "$BASE/v1/responses" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"model":"'"$MODEL"'","input":"and now?","previous_response_id":"resp_..."}'
```

Tool-call wiring, structured output, and the streaming event schema match OpenAI's documented Responses behaviour.

### `POST /v1/images/edits` on `qvac serve openai` (img2img)

Companion to `/v1/images/generations`, exposing the SDK diffusion primitive's `init_image` / `strength` (img2img) knob through the OpenAI surface. Multipart-only, with the same model gating, response shape, and SSE behaviour as `/v1/images/generations`:

```bash
# img2img against a loaded diffusion model
curl http://localhost:11434/v1/images/edits \
  -F "image=@input.png" \
  -F "model=my-diffusion" \
  -F "prompt=oil painting, warm light" \
  -F "strength=0.65"
```

```json
{
  "created": 1718000000,
  "output_format": "png",
  "size": "1024x1024",
  "data": [{ "b64_json": "iVBORw0KGgoAAAANSUhEUgAA..." }]
}
```

The route ships alongside a broader hardening pass on the image surface — every OpenAI field that can't be honoured 1:1 (`mask`, `output_format` ≠ `png`, `output_compression`, `background`, `strength` outside `[0,1]`, `response_format=url` without `--public-base-url`) now returns `400` with a stable `error.code` instead of warn-and-proceed. See breaking changes below for the `response_format=url` migration and the new `--public-base-url` flag.

### CLI cancel bridge — client disconnect cancels in-flight inference

Every `qvac serve openai` route (chat completions, embeddings, audio transcriptions, audio translations) now binds `req.on('close')` to the SDK's `cancel({ requestId })` via a shared `core/cancel-bridge.ts` helper. Long-running inference is no longer wasted when the client disconnects; the SDK releases the worker slot within one decode tick, freeing concurrent requests blocked behind cancel-policy gates.

The wire is the new `requestId` exposed synchronously on the SDK's decorated promises (`completion`, `embed`, `transcribe`, `loadModel`, `downloadAsset`, `ragIngest`, `ragSaveEmbeddings`, `ragReindex`). The CLI binds the disconnect listener on the same tick as the dispatch — there is no race window where the request is in-flight on the worker but unbindable on the route handler.

```typescript
// Inside qvac serve route handler (illustrative)
import { sdkCompletion } from '@qvac/cli/serve/core/sdk'
import { bindClientDisconnectCancel } from '@qvac/cli/serve/core/cancel-bridge'

const run = sdkCompletion({
  /* ... */
})
bindClientDisconnectCancel(req, res, run.requestId, logger)
const final = await run.final
```

The bridge is idempotent (`req.once('close', ...)`), short-circuits if the response already finished (`res.writableEnded`), and swallows the `sdkCancel` rejection so a slow-or-failed cancel never breaks the response handler.

---

## 💥 Breaking Changes

Two `cancel(...)` call shapes are removed from `@qvac/sdk` in 0.11.0 (which `@qvac/cli` now depends on via `^0.11.0`). The CLI itself doesn't expose these directly, but consumers calling the SDK from CLI plugins or downstream code — and the underlying `qvac serve` cancel surface — must migrate. See [breaking changes](./breaking.md) for the full BEFORE/AFTER, including the `requestId`-targeted primary path and the broad-cancel-by-`modelId` escape hatch.

The image generation route's `response_format=url` no longer falls back to a `data:image/png;base64,…` URL. Existing callers must pass `response_format=b64_json` (or omit; `b64_json` is the default) or run the server with `--public-base-url <origin>` so the URL is a real fetchable HTTPS URL backed by `GET /v1/files/{id}/content`. Without one of those, the route returns `400 unsupported_response_format` with an instructive message.

A `mask` / `mask[]` part on `/v1/images/edits` is rejected with `400 mask_not_supported` (no mask channel in the diffusion engine). Use prompt-only edits until the underlying engine ships a mask channel.

---

## 🧹 Maintenance

The CLI now tracks `@qvac/sdk@^0.11.0` (was `^0.10.0`) and the runtime `MIN_SDK_VERSION` check in `serve/core/sdk.ts` is bumped from `'0.10.0'` to `'0.11.0'`. Because `@qvac/sdk` is a `devDependency` of `@qvac/cli` (the SDK is brought by the consuming project, not bundled by the CLI), the runtime check is the actual user-visible enforcement: `qvac serve openai` now refuses to start if the resolved `@qvac/sdk` is older than `0.11.0` and prints `@qvac/sdk <version> is too old for this version of @qvac/cli. Minimum required: 0.11.0. Run: npm install @qvac/sdk@latest`. The dep bump is the explicit reason the CLI cancel bridge can land — the `requestId` decoration on `loadModel` / `downloadAsset` / `ragIngest` / `ragSaveEmbeddings` / `ragReindex` is a 0.11.0 SDK addition and the `cancelHandler` retirement on the SDK side is what makes `cancel({ requestId })` dispatch directly into the new `RequestRegistry`.
