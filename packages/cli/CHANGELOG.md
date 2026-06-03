# Changelog

## [0.6.0]

Release Date: 2026-06-02

📦 **NPM:** https://www.npmjs.com/package/@qvac/cli/v/0.6.0

This release makes `@qvac/sdk` a first-class runtime dependency of the CLI: installing `@qvac/cli` now always pulls in `@qvac/sdk@^0.12.0`, the `bundle`/`verify` commands delegate entirely to `@qvac/sdk/commands`, and the old runtime SDK-version check is gone. The `qvac serve openai` HTTP layer is rebuilt on Fastify + Zod with stricter, OpenAI-aligned error codes, and gains an asynchronous video-generation endpoint. The CLI also adds an OpenAI coverage report and tracks the SDK's text-to-speech migration to the ggml engine.

---

## Breaking Changes

### `@qvac/sdk` is now a regular dependency; no more runtime version check

The SDK was previously a dev-only dependency that the CLI expected the host project to supply, with a runtime `MIN_SDK_VERSION` floor enforced when `qvac serve openai` started. The CLI now declares `@qvac/sdk` under `dependencies` at `^0.12.0`, so it is always installed alongside the CLI. Compatibility is enforced by the dependency range at install time, and the runtime semver check has been removed — `qvac serve openai` no longer inspects the resolved SDK version or aborts startup over it.

This is the first release that depends on the published `@qvac/sdk@0.12.0` `./commands` subpath, into which the bundle/verify implementation moved. There is nothing for consumers to do beyond a normal install; the SDK comes with the CLI.

**Before:**
```json
{
  "devDependencies": {
    "@qvac/sdk": "^0.11.0"
  }
}
```

**After:**
```json
{
  "dependencies": {
    "@qvac/sdk": "^0.12.0"
  }
}
```

### `bundle` and `verify` delegate to `@qvac/sdk/commands`

`qvac bundle sdk` and `qvac verify bundle` are now thin wrappers that re-export the implementation from `@qvac/sdk/commands`. Command-line behaviour and flags are unchanged, but the logic — including model-source resolution — lives in the SDK. Resolved model entries used by `serve` now carry a `modelSrc` (string or model constant) that the SDK turns into a `registry://` URL, rather than the CLI constructing that URL itself.

### Unknown serve models return `404 model_not_found`

With the Fastify + Zod rewrite of the `serve` HTTP layer, request validation and error codes are aligned with OpenAI semantics. A request naming a model that is not configured now fails with `404 model_not_found` instead of being rejected later as a `400` on an unrelated field such as `output_format`.

**Before:**
```sh
$ curl -sX POST .../v1/images/generations \
    -H 'Content-Type: application/json' \
    -d '{"model":"unknown","prompt":"hi","output_format":"jpeg"}'

400 { "error": { "code": "unsupported_output_format", ... } }
```

**After:**
```sh
$ curl -sX POST .../v1/images/generations \
    -H 'Content-Type: application/json' \
    -d '{"model":"unknown","prompt":"hi","output_format":"jpeg"}'

404 { "error": { "code": "model_not_found", ... } }
```

---

## New APIs

### OpenAPI document and `qvac openai spec`

The `qvac serve openai` HTTP layer was rebuilt on Fastify with Zod-validated routes, and the server now generates its OpenAPI 3.1.0 document from those per-route schemas, so the spec always matches what the server validates. `GET /openapi.json` is always available; `GET /docs` serves Swagger UI when the server is started with `--docs` (off by default). A new `qvac openai spec` command emits the document without starting the server:

```bash
qvac openai spec                 # JSON to stdout
qvac openai spec --yaml          # YAML to stdout
qvac openai spec -o spec.json    # write to a file
```

### OpenAI-compatible video generation (`/v1/videos`)

`qvac serve openai` now exposes text-to-video on the OpenAI `/v1/videos` surface, backed by the SDK's `sdcpp-video` model type. Generation is asynchronous: `POST /v1/videos` returns a job that you poll with `GET /v1/videos/{id}`, fetch with `GET /v1/videos/{id}/content`, and clean up with `DELETE /v1/videos/{id}`.

Configure a video model in `qvac.config.json`:
```json
{
  "serve": {
    "models": {
      "wan-t2v": {
        "src": "WAN2_1_T2V_1_3B_FP16",
        "type": "sdcpp-video",
        "preload": true,
        "config": {
          "t5XxlModelSrc": "UMT5_XXL_FP16",
          "vaeModelSrc": "WAN_2_1_COMFYUI_REPACKAGED_VAE",
          "offload_to_cpu": true
        }
      }
    }
  }
}
```

```bash
# Submit a job
ID=$(curl -sS -X POST http://127.0.0.1:11434/v1/videos \
  -H 'content-type: application/json' \
  -d '{"model":"wan-t2v","prompt":"a red ball bouncing","size":"416x240","seconds":"1","fps":16,"steps":1}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')

# Poll, then download the rendered video
curl -sS "http://127.0.0.1:11434/v1/videos/${ID}"
curl -sS "http://127.0.0.1:11434/v1/videos/${ID}/content" -o out.mp4
```

### `qvac openai coverage` report

A new command reports how much of the OpenAI API surface `qvac serve openai` implements, comparing the live (or cached) OpenAI spec against the CLI's router. It groups endpoints by category, highlights the consumer-demanded "primary AI" surface, and supports filtering and JSON output:

```bash
qvac openai coverage                  # full report (spec cached under ~/.cache/qvac/)
qvac openai coverage --primary-ai     # inference surface only
qvac openai coverage --unsupported    # endpoints not yet implemented
qvac openai coverage --json
qvac openai coverage --offline        # use the cached spec only
```

---

## Other Changes

### Bundler resolves `@qvac/sdk` from hoisted `node_modules`

`qvac bundle sdk` now walks ancestor `node_modules` to locate `@qvac/sdk`, so it works when the SDK is hoisted to a workspace root (for example running it from `apps/mobile` in a monorepo). If the SDK cannot be found in any ancestor, the error explains how to fix it — install at the project root or pass `--sdk-path <path>` — instead of failing on a missing internal file.

---

## Model Changes

The SDK's text-to-speech stack moved from the ONNX engine to the ggml engine, and the CLI tracks that change. The plugin import path changes from `@qvac/sdk/onnx-tts/plugin` to `@qvac/sdk/tts-ggml/plugin` (a compatibility alias is retained temporarily), and TTS model configuration uses the new `s3genModelSrc` knob.

Models added in this release:

- TTS (Chatterbox): `TTS_S3GEN_EN_CHATTERBOX`, `TTS_S3GEN_MULTILINGUAL_CHATTERBOX`, `TTS_T3_TURBO_EN_CHATTERBOX_FP16`, `TTS_T3_TURBO_EN_CHATTERBOX_Q8_0`, `TTS_T3_TURBO_EN_CHATTERBOX_Q4_0`, `TTS_T3_MULTILINGUAL_CHATTERBOX_FP16`, `TTS_T3_MULTILINGUAL_CHATTERBOX_Q8_0`, `TTS_T3_MULTILINGUAL_CHATTERBOX_Q4_0`
- TTS (Supertonic): `TTS_EN_SUPERTONIC_Q8_0`, `TTS_EN_SUPERTONIC_Q4_0`, `TTS_MULTILINGUAL_SUPERTONIC2_Q8_0`, `TTS_MULTILINGUAL_SUPERTONIC2_Q4_0`

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
