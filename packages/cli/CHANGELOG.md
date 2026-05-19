# Changelog

## [0.5.0]

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
import { sdkCompletion } from "@qvac/cli/serve/core/sdk";
import { bindClientDisconnectCancel } from "@qvac/cli/serve/core/cancel-bridge";

const run = sdkCompletion({ /* ... */ });
bindClientDisconnectCancel(req, res, run.requestId, logger);
const final = await run.final;
```

The bridge is idempotent (`req.once('close', ...)`), short-circuits if the response already finished (`res.writableEnded`), and swallows the `sdkCancel` rejection so a slow-or-failed cancel never breaks the response handler.

---

## 💥 Breaking Changes

Two `cancel(...)` call shapes are removed from `@qvac/sdk` in 0.11.0 (which `@qvac/cli` now depends on via `^0.11.0`). The CLI itself doesn't expose these directly, but consumers calling the SDK from CLI plugins or downstream code — and the underlying `qvac serve` cancel surface — must migrate. See [breaking changes](./changelog/0.5.0/breaking.md) for the full BEFORE/AFTER, including the `requestId`-targeted primary path and the broad-cancel-by-`modelId` escape hatch.

The image generation route's `response_format=url` no longer falls back to a `data:image/png;base64,…` URL. Existing callers must pass `response_format=b64_json` (or omit; `b64_json` is the default) or run the server with `--public-base-url <origin>` so the URL is a real fetchable HTTPS URL backed by `GET /v1/files/{id}/content`. Without one of those, the route returns `400 unsupported_response_format` with an instructive message.

A `mask` / `mask[]` part on `/v1/images/edits` is rejected with `400 mask_not_supported` (no mask channel in the diffusion engine). Use prompt-only edits until the underlying engine ships a mask channel.

---

## 🧹 Maintenance

The CLI now tracks `@qvac/sdk@^0.11.0` (was `^0.10.0`) and the runtime `MIN_SDK_VERSION` check in `serve/core/sdk.ts` is bumped from `'0.10.0'` to `'0.11.0'`. Because `@qvac/sdk` is a `devDependency` of `@qvac/cli` (the SDK is brought by the consuming project, not bundled by the CLI), the runtime check is the actual user-visible enforcement: `qvac serve openai` now refuses to start if the resolved `@qvac/sdk` is older than `0.11.0` and prints `@qvac/sdk <version> is too old for this version of @qvac/cli. Minimum required: 0.11.0. Run: npm install @qvac/sdk@latest`. The dep bump is the explicit reason the CLI cancel bridge can land — the `requestId` decoration on `loadModel` / `downloadAsset` / `ragIngest` / `ragSaveEmbeddings` / `ragReindex` is a 0.11.0 SDK addition and the `cancelHandler` retirement on the SDK side is what makes `cancel({ requestId })` dispatch directly into the new `RequestRegistry`.

## [0.4.0]

Release Date: 2026-05-13

📦 **NPM:** https://www.npmjs.com/package/@qvac/cli/v/0.4.0

This release adds a new `qvac verify` command group for native-addon hygiene (lockfile diffs and bundle/ABI validation before things break on-device), wires image generation into the OpenAI-compatible HTTP server, and surfaces the new SDK `reasoning_budget` and Qwen3.5 / Gemma4 tool-call dialects through `qvac serve`.

---

## 🔌 New APIs

### `qvac verify deps` — catch native addon lockfile churn early

Worker bundles can silently inherit new native Bare addons through transitive lockfile changes, and the breakage only shows up later in the bundle step or on-device. `qvac verify deps` is a CI-friendly guardrail that compares two git refs' `package-lock.json` and reports added/removed native addons before packaging.

```bash
qvac verify deps --base upstream/main --head HEAD
qvac verify deps --base origin/main --head HEAD --quiet
qvac verify deps --base upstream/main --head HEAD \
  --lockfile packages/sdk/package-lock.json
```

Exit codes are designed for CI guardrails: `0` for no native changes (or no npm lockfile present at either ref), `1` for added/removed natives or a removed package whose native status could not be determined, and `2` for tool errors (missing args, unsupported lockfile, unresolvable git ref). Detection is npm-only — `package-lock.json` is the source of truth.

### `qvac verify bundle` — validate prebuilds and ABI before shipping

A companion to `verify deps`: where the former flags lockfile churn, `verify bundle` validates the actual artifact. Given a `worker.bundle.js` or a `node_modules` directory, and one or more target hosts, it checks that every native addon ships a `.bare` prebuild for each host and that each addon's `engines.bare` range is compatible with the resolved Bare runtime.

```bash
qvac verify bundle --addons-source qvac/worker.bundle.js \
  --host ios-arm64 \
  --host ios-arm64-simulator \
  --host ios-x64-simulator \
  --host android-arm64

qvac verify bundle --addons-source ./node_modules \
  --host darwin-arm64 \
  --host linux-x64 \
  --host win32-x64

qvac verify bundle --addons-source qvac/worker.bundle.js \
  --host ios-arm64 \
  --bare-runtime-version 1.26.0
```

The Bare runtime version is resolved in order: explicit `--bare-runtime-version` flag, then `bare-runtime/package.json`, then `bare/package.json`. Mobile and Expo CI should pass `--bare-runtime-version` explicitly — `react-native-bare-kit` does not expose embedded runtime metadata.

Pinning the runtime version also works via a `qvac.config.{json,js,mjs,ts}` file auto-detected from the current directory (or pointed at with `--config <path>`):

```json
// qvac.config.json
{ "bareRuntimeVersion": "1.26.0" }
```

```bash
qvac verify bundle --addons-source qvac/worker.bundle.js --host ios-arm64
```

Issue codes:

- **Errors** (exit `1`): `missing-prebuild`, `abi-mismatch`, `invalid-runtime-version`, `invalid-source`.
- **Warnings** (exit `0`): `unknown-runtime-version`, `malformed-engines-bare`.

### `POST /v1/images/generations` on `qvac serve openai`

The OpenAI-compatible HTTP server now exposes image generation, backed by the SDK `diffusion()` primitive. The startup banner lists `POST /v1/images/generations` whenever an `image`-category model is configured. The route is a stateless adapter — request → SDK → response, no storage, no re-encoding.

Configure a diffusion model (and, optionally, alias common OpenAI model names like `gpt-image-2` to it for drop-in client compatibility):

```json
// qvac.config.json
{
  "serve": {
    "models": {
      "sd21": {
        "model": "SD_V2_1_1B_Q4_0",
        "default": true,
        "preload": true,
        "config": { "prediction": "v" }
      }
    }
  }
}
```

Blocking JSON response (default):

```json
{
  "created": 1718000000,
  "output_format": "png",
  "size": "1024x1024",
  "data": [
    { "b64_json": "iVBORw0KGgoAAAANSUhEUgAA..." }
  ]
}
```

Streaming (`stream: true`) returns a single `image_generation.completed` SSE event followed by `[DONE]`, matching OpenAI's documented `partial_images: 0` behaviour:

```
event: image_generation.completed
data: {"type":"image_generation.completed","created_at":1718000000,"output_format":"png","size":"1024x1024","b64_json":"iVBORw0KGgoAAAANSUhEUgAA..."}

data: [DONE]
```

Behaviour notes:

- `size = "WxH"` (multiples of 8) or `"auto"`; absent → SDK defaults.
- `n` is a positive integer, forwarded as-is to SDK `batch_count` (no upper clamp). `n < 1`, non-integer, or non-number → `400 invalid_n`.
- `response_format` defaults to `b64_json`; `"url"` returns `data:image/png;base64,...`. Ignored when `stream: true`.
- `output_format=jpeg|webp` is accepted but the body is still PNG; the response echoes `output_format: "png"` so clients can detect the mismatch and decide whether to fall back. Honoring other encodings server-side will likely require an encoder dependency (e.g. `sharp`) and is tracked separately.
- `quality`, `style`, `background`, `moderation`, `output_compression`, `partial_images`, and `user` are accepted and warned.

### Qwen3.5 / Gemma4 tool-call dialects and `reasoning_budget` through `qvac serve`

The SDK now parses Qwen3.5 / Qwen3.6 (Pythonic-XML: `<tool_call><function=NAME><parameter=KEY>VALUE</parameter></function></tool_call>`) and Gemma4 (`<|tool_call>call:NAME{...}<tool_call|>`) tool-call output formats, with auto-detection from the model name/path. The CLI exposes this transparently through the OpenAI chat-completions surface and adds `reasoning_budget` to the request body as a boolean (`true` → `-1` unrestricted, `false` → `0` disabled):

```json
POST /v1/chat/completions
{
  "model": "qwen35",
  "messages": [{ "role": "user", "content": "Think step by step." }],
  "reasoning_budget": false
}
```

Requires `@qvac/sdk@^0.10.0`. Tool-call examples for both dialects live under the SDK's `examples/tools/`.

---

## 🧹 Maintenance

The repo-wide PR template consolidation deleted the stale `packages/cli/PULL_REQUEST_TEMPLATE.md` (along with 18 other unused per-package copies). GitHub only ever auto-discovered the two canonical templates at `.github/PULL_REQUEST_TEMPLATE/{sdk-pod,addon}.md`, and the CLI's per-package template was invisible to the GitHub UI; only ad-hoc tooling that read it was ever affected, and that tooling now points at the canonical addon template. No behaviour change for end users of `@qvac/cli`.

## [0.3.0]

Release Date: 2026-04-30

## 🔌 API

- Wire OpenAI's standard `response_format` field through `qvac serve` (POST `/v1/chat/completions`). The body field is parsed, validated, and forwarded to the SDK as `responseFormat`, enabling structured-output requests (`text` / `json_object` / `json_schema`) over the OpenAI-compatible HTTP surface. Requires `@qvac/sdk` `^0.10.0`. (see PR [#1810](https://github.com/tetherto/qvac/pull/1810)) - See [API changes](./changelog/0.3.0/api.md)

## [0.2.4]

Release Date: 2026-04-27

## 🐞 Fixes

- Update `SDKModule.embed` type and `sdkEmbed()` to handle the new `{ embedding, stats? }` return shape introduced in `@qvac/sdk` 0.9+. The CLI's internal `number[] | number[][]` contract is preserved so callers (notably the OpenAI embeddings route) stay unchanged. (see PR [#1596](https://github.com/tetherto/qvac/pull/1596))
- Extract nested `node_modules` packages when generating the addons manifest in `qvac bundle sdk`, so deeply-hoisted addon dependencies are correctly included in the mobile worker bundle. (see PR [#1731](https://github.com/tetherto/qvac/pull/1731))

## [0.2.2]

Release Date: 2026-03-19

## 🔌 API

- Add OpenAI-compatible REST API server (qvac serve) - Part I. (see PR [#753](https://github.com/tetherto/qvac/pull/753)) - See [API changes](./changelog/0.2.2/api.md)
- Bump LLM/embed addons and wire per-request generation params. (see PR [#895](https://github.com/tetherto/qvac/pull/895))
- Add POST /v1/audio/transcriptions to qvac serve OpenAI adapter. (see PR [#915](https://github.com/tetherto/qvac/pull/915)) - See [API changes](./changelog/0.2.2/api.md)

## 🐞 Fixes

- Resolve Windows EFTYPE error when spawning bare-pack. (see PR [#949](https://github.com/tetherto/qvac/pull/949))
- Normalize composite JSON Schema types in tool parameter validation. (see PR [#964](https://github.com/tetherto/qvac/pull/964))

## 🧹 Chores

- Rename qvac-cli package to cli. (see PR [#644](https://github.com/tetherto/qvac/pull/644))
- Migrate CLI package from JavaScript to TypeScript. (see PR [#722](https://github.com/tetherto/qvac/pull/722))

## ⚙️ Infrastructure

- Add explicit build step to CLI publish workflow. (see PR [#1010](https://github.com/tetherto/qvac/pull/1010))
