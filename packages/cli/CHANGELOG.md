# Changelog

## [0.12.0]

📦 **NPM:** https://www.npmjs.com/package/@qvac/cli/v/0.12.0

This release closes the gap between installing the CLI and having a working server. `qvac configure` writes a valid `qvac.config.json` for you, a new catalog endpoint lets you browse the models the SDK provides, and `qvac serve openai` finally honours `preload: false` by loading on first use instead of failing forever. `qvac doctor --deep` can now prove the installed SDK actually starts.

## New Commands

### `qvac configure` builds your config for you

Getting from a fresh install to a working `qvac serve openai` used to mean hand-writing `serve.models` and knowing model constant names. `qvac configure` does it interactively: add a model by capability or search everything, preview the entry it will write, edit it in `$EDITOR` if you want, then merge and save.

```bash
qvac configure                                  # interactive
qvac configure --yes                            # chat + transcription starter
qvac configure --modality chat --modality image  # pick specific capabilities
```

Search matches on name, role, addon, and quantization, with id matches ranked first. Aliases are derived from the model name (`QWEN3_600M_INST_Q4` → `qwen3-600m-inst-q4`) and deduped. For llamacpp chat and embedding entries the prompts are schema-driven — type hints, field descriptions, and per-field validation come from the SDK's own config schemas.

Writes are safe: the config is written atomically, an existing `qvac.config.json` is merged rather than replaced, and the command refuses to shadow a non-JSON config (`.js`/`.ts`), printing guidance instead. Re-running is idempotent per model; `--force` overwrites an existing entry in place. `Esc` steps back one menu and `Ctrl+C` aborts without writing anything.

Chat, embedding, transcription, and image presets are runnable as written. TTS is an example template carrying a `referenceAudioSrc` placeholder and a link to the addon docs, because a voice reference cannot be guessed — the command is honest about where you have to finish the job by hand.

This is the actionable end of the catalog's `not_configured` hint: browse a model with `GET /v1/models/catalog`, then run `qvac configure` to make it callable.

## New APIs

### Browse available models by capability

`GET /v1/models` only ever described models you had already configured, so there was no way to find out what else the SDK could run. `GET /v1/models/catalog` now lists configured models alongside the SDK's in-process constant catalog, filterable by capability:

```bash
# Chat-capable models, 20 at a time
curl 'http://localhost:11434/v1/models/catalog?role=chat&limit=20'

# Free-text search on the model id
curl 'http://localhost:11434/v1/models/catalog?search=qwen'

# A single entry
curl 'http://localhost:11434/v1/models/catalog/QWEN3_600M_INST_Q4'
```

Filters cover `search`, `role`, `addon` (or `type`), `quantization`, `engine`, and `configured`, with `limit`/`offset` pagination and a `has_more` flag.

Entries are deliberately **not** OpenAI `model` objects — they are `model_catalog_entry` rows, because a catalog model that is absent from `serve.models` cannot be called on this server:

```json
{
  "object": "model_catalog_entry",
  "id": "QWEN3_600M_INST_Q4",
  "configured": false,
  "usable": false,
  "state": "not_configured",
  "role": "chat",
  "addon": "llm",
  "quantization": "q4",
  "params": "600M",
  "size": 382156480,
  "hint": "…"
}
```

Every row carries `configured`, `usable`, and a `state` that includes a `not_configured` value for catalog-only models, plus a `hint` pointing at how to configure it. `GET /v1/models` remains the single authoritative list of callable models, so a browsable model can never be mistaken for a ready one.

Browsing is fully in-process: it triggers no SDK call, no model load, and no download. Sizes, parameter counts, quantizations, and roles come from the constants, while configured models report their live registry state.

## New Flags

### `qvac doctor --deep` proves the SDK actually runs

The static `qvac doctor` checks could pass on an install whose SDK worker could not start, finish its heartbeat, or shut down cleanly. `--deep` exercises the installed `@qvac/sdk` in an isolated child process — import, worker heartbeat, and shutdown — without loading a model:

```bash
qvac doctor --deep
qvac doctor --deep --verbose   # include probe diagnostics
qvac doctor --deep --json      # machine-readable result
```

It requires a structured IPC result and a matching process exit code, so a probe that dies quietly is a failure rather than a pass. Common CPU, native-library, Visual C++ runtime, Vulkan, Bare, and worker-handshake failures are classified rather than reported as one generic error. Plain `qvac doctor` behaviour is unchanged unless `--deep` is passed.

### Lazy loading is tunable, and can be turned off

Lazy loading is on by default. Four new `qvac serve openai` flags control it:

```bash
# Refuse to load on demand — an unloaded model returns 503 model_not_loaded
qvac serve openai --no-lazy-load

# Allow two models to load at once (default: 1)
qvac serve openai --load-concurrency 2

# Give up on a cold start after 5 minutes (default: unbounded)
qvac serve openai --load-timeout 300000

# Finish a load even if the client that triggered it disconnects
qvac serve openai --no-cancel-load-on-disconnect
```

The same settings are available in the config file under a new `serve.load` block, which the flags override:

```json
{
  "serve": {
    "load": {
      "lazy": true,
      "concurrency": 1,
      "timeoutMs": null,
      "cancelOnDisconnect": true
    }
  }
}
```

`concurrency` and `timeoutMs` must be positive integers; `timeoutMs: null` means no timeout. A config value that is the wrong type or out of range fails startup with the offending path named, rather than being silently ignored.

## Bug Fixes

### `preload: false` now lazy-loads instead of failing forever

A model configured with `preload: false` was registered but never loaded, so every request naming it returned `503 model_not_ready` indefinitely — despite the documented promise of a lazy cold start. Such a model now loads the first time a request names it.

The load is concurrency-safe: simultaneous first requests share a single load rather than starting several, and a failed cold start surfaces as `503 model_load_failed` and is retried on the next request instead of poisoning the alias.

```bash
# First request loads the model (and blocks while it does); later requests are fast
curl -X POST http://localhost:11434/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"my-llm","messages":[{"role":"user","content":"hi"}]}'
```

Preload defaults are unchanged: constant entries still default to `true`, explicit `{ src, type }` entries to `false`, and `--model <alias>` still forces a warm start.

### Unloading a model is reversible

`DELETE /v1/models/{id}` used to remove the alias from the registry with no way back. The model stayed resolvable from config but was permanently unavailable until the server was restarted. It now resets the alias to `IDLE` and drops the SDK handle, freeing the resources while leaving the alias intact, so the next request simply reloads it:

```bash
# Frees resources but keeps the alias; the next request reloads it
curl -X DELETE http://localhost:11434/v1/models/my-llm
```

Listing follows the same principle. `GET /v1/models` reports every configured model whether or not it is loaded, and `GET /v1/models/{id}` resolves any configured alias, so loading stays transparent to the client. All inference gates — the model requirement check, audio speech, and vector-store embedding — now share one readiness helper, so they agree on when a model is usable.

## Requirements

This release requires `@qvac/sdk@^0.18.1`. `qvac configure` reads its llamacpp field descriptions and validation from the `@qvac/sdk/schemas` subpath, which 0.18.1 is the first SDK release to export.

It also adds one third-party dependency, `@inquirer/prompts` (pinned to `8.5.2`), for the interactive prompts.

## [0.11.0]

📦 **NPM:** https://www.npmjs.com/package/@qvac/cli/v/0.11.0

This release tightens the security posture of `qvac serve`. Browser access now requires an explicit list of trusted origins, a bind beyond loopback refuses to start without authentication, and the bearer key can be read from a file instead of the command line. Existing `--cors` and `--host` invocations will need updating.

## Breaking Changes

### Trusted browser origins must be named explicitly

`--cors` no longer opens the server to every origin. It is now only a compatibility validation switch: it does not enable CORS by itself, and it fails startup unless at least one exact origin is supplied through `--cors-origin` or `serve.cors.origins`. Wildcards are rejected, as are origins ending in a trailing dot, which no browser sends.

`--docs` no longer inherits wildcard access either. It adds same-port `localhost`, `127.0.0.1`, and `[::1]` origins for Swagger UI, and it rejects `--port 0`, because a same-port origin cannot be computed before the port is known.

**Before:**

```bash
qvac serve openai --cors --docs
```

**After:**

```bash
qvac serve openai --cors --cors-origin https://app.example.com
```

### A non-loopback bind must authenticate

Binding beyond `127.0.0.1` used to log a warning and start anyway, which quietly exposed an unauthenticated API to the network. It now fails startup unless a key is supplied, or unless the operator says outright that the exposure is intended.

**Before:**

```bash
# Warned, then served the whole network with no authentication.
qvac serve openai --host 0.0.0.0
```

**After:**

```bash
# Require a bearer token...
qvac serve openai --host 0.0.0.0 --api-key-file ~/.qvac/serve-key

# ...or accept the risk explicitly, which warns and starts as before.
qvac serve openai --host 0.0.0.0 --allow-unauthenticated
```

## New Flags

### `--api-key-file` keeps the credential out of the process list

`--api-key <key>` places the token in the process's command line, which `/proc/<pid>/cmdline` exposes to every local account on Linux. `--api-key-file <path>` reads it from a file instead:

```bash
printf '%s' "$QVAC_API_KEY" > ~/.qvac/serve-key
chmod 600 ~/.qvac/serve-key
qvac serve openai --api-key-file ~/.qvac/serve-key
```

The path must be a regular file — symlinks and directories are refused — and the CLI warns when the file is readable beyond its owner. `--api-key` and `--api-key-file` are mutually exclusive.

### `--allow-unauthenticated` opts back into an open bind

For operators who genuinely want an unauthenticated listener beyond loopback, this restores the previous warn-and-start behaviour. Anyone who can reach the address can use the server.

## [0.10.0]

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

## [0.9.0]

📦 **NPM:** https://www.npmjs.com/package/@qvac/cli/v/0.9.0

This release moves the CLI to `@qvac/sdk` 0.16.0 and improves compatibility and performance for clients using the OpenAI-compatible server. It adds structured reasoning and token usage, preserves native tool-call replay for Qwen3.5 models, reuses the KV cache across chat turns, and fixes published-install coverage checks.

## Richer OpenAI-Compatible Chat Responses

Chat completions now expose model reasoning through `reasoning_content` instead of mixing thinking blocks into normal response content. Responses also report prompt, completion, total, and cached token counts from the underlying inference engine.

Streaming clients can request a final usage chunk using the OpenAI-compatible `stream_options.include_usage` option:

```json
{
  "model": "qwen3.5",
  "stream": true,
  "stream_options": { "include_usage": true },
  "messages": [{ "role": "user", "content": "Hello" }]
}
```

The final server-sent event contains an empty `choices` array and the completed usage totals. Existing streaming requests that do not opt in continue without a usage chunk.

## More Reliable Multi-Turn Tool Calls

When a conversation replays an earlier structured tool call, the server now renders Qwen3.5 calls in the model's native tool dialect. This prevents foreign tool markup from leaking into response content and keeps follow-up tool calls parseable by coding agents and other OpenAI-compatible clients.

## Faster Repeated Chat Turns

The OpenAI-compatible chat endpoints now enable KV-cache reuse automatically. Repeated turns can reuse the cached conversation prefix, reducing prompt processing work without requiring clients to change their requests.

## File Upload Compatibility

Uploaded files now retain their original MIME type in the CLI's ephemeral file store. Content responses return the preserved type, allowing AI SDK provider file workflows to handle uploaded media correctly.

The companion `@qvac/ai-sdk-provider` release moves to AI SDK 7, provider v4, Node.js 22 or newer, and ESM-only usage. These breaking requirements apply to that provider package; `@qvac/cli` itself continues to declare Node.js 18 or newer.

## Bug Fixes

The OpenAI coverage command now resolves its router files relative to the installed package, so it no longer crashes when run from a published CLI installation. Server-side request failures also include full stack traces in logs, making production errors easier to diagnose.

## Documentation and Verification

The CLI documentation now states the Vulkan 1.4 minimum and removes an inaccurate CPU-fallback claim. A typed benchmark harness compares supported OpenAI providers and is included in the unit-test workflow to catch compatibility regressions.

## [0.8.1]

📦 **NPM:** https://www.npmjs.com/package/@qvac/cli/v/0.8.1

This is a maintenance release. It fixes a diagnostics gap in the OpenAI-compatible server, corrects a documentation claim about Vulkan GPU fallback behavior, and moves the CLI onto `@qvac/sdk` 0.15.0.

## Other Changes

Server errors are now logged with their full stack trace when a request handler throws, making failures easier to diagnose from server logs rather than only the client-facing error response. The Vulkan backend documentation now states the correct minimum required Vulkan version (1.4) and removes an inaccurate claim about CPU fallback behavior. The CLI's committed `@qvac/sdk` dependency now targets `^0.15.0`. Lint, format, and typecheck tooling was also unified across SDK-pod packages with Prettier, with no user-facing effect.

## [0.8.0]

📦 **NPM:** https://www.npmjs.com/package/@qvac/cli/v/0.8.0

This release brings the OpenAI-compatible server up to `@qvac/sdk` 0.14.1 and adds vision input plus two reasoning-control knobs to `/v1/chat/completions`. Installing this version is how OpenCode, the AI SDK provider, and direct `qvac serve` users pick up the SDK 0.14.1 runtime.

## New APIs

### Image input in chat completions

`POST /v1/chat/completions` now accepts OpenAI-style `image_url` content parts, so vision-capable models can be driven through the same request shape OpenAI clients already use. Pass a base64 data URI or an HTTP(S) URL alongside text parts:

```json
{
  "model": "<vlm-alias>",
  "stream": true,
  "messages": [
    {
      "role": "user",
      "content": [
        { "type": "text", "text": "What is in this image?" },
        { "type": "image_url", "image_url": { "url": "data:image/png;base64,<...>" } }
      ]
    }
  ]
}
```

Plain string content keeps working unchanged.

### Drop reasoning from context with remove_thinking_from_context

Reasoning models can now discard a turn's thinking block from the KV cache after generation, keeping the context window focused on the visible conversation. Set the flag on the request body:

```jsonc
// POST /v1/chat/completions
{
  "model": "qwen3...",
  "messages": [/* ... */],
  "remove_thinking_from_context": true
}
```

### Sturdier Gemma4 completions

Gemma4 completion draining is hardened so requests that cap reasoning (for example `reasoning_budget: 0`) finish cleanly instead of stalling on the drain path:

```json
{
  "model": "gemma4-31b",
  "messages": [{ "role": "user", "content": "The ocean is" }],
  "reasoning_budget": 0
}
```

## Other Changes

The CLI's committed `@qvac/sdk` dependency now targets `^0.14.1`. Documentation gained an OpenCode plugin model-selection guide and an agent-stack test-ownership map, and the e2e suite was migrated from BATS to a `node:test` suite with added coverage for OpenAI chat-agent request shapes.

## [0.7.0]

📦 **NPM:** https://www.npmjs.com/package/@qvac/cli/v/0.7.0

This release adds image-to-video generation and audio encoding to the OpenAI-compatible HTTP server. It also fixes token accounting and `finish_reason` reporting across all chat-category routes.

## New Features

### Image-to-video via POST /v1/videos

`POST /v1/videos` now supports img2vid in addition to txt2vid. Supply the reference image as a multipart file field (the form the OpenAI SDK sends for `Uploadable`), as a JSON `{ image_url }` (base64 data URI or HTTP(S) URL up to 100 MB), or as a JSON `{ file_id }` referencing a previously uploaded file. Mode is inferred automatically from the presence of `input_reference`.

```typescript
import OpenAI, { toFile } from 'openai'
import fs from 'node:fs'

const client = new OpenAI({ baseURL: 'http://localhost:11434/v1' })

// img2vid via local file (multipart)
const job = await client.videos.create({
  model: 'wan-i2v',
  prompt: 'subject slowly turns and smiles',
  input_reference: await toFile(fs.createReadStream('./frame.png'), 'frame.png')
})

// img2vid via data URI (JSON)
const job2 = await client.videos.create({
  model: 'wan-i2v',
  prompt: 'subject slowly turns and smiles',
  input_reference: { image_url: 'data:image/png;base64,...' }
})
```

### Audio encoding — mp3, opus, aac, flac

`POST /v1/audio/speech` now supports `response_format: "mp3"`, `"opus"`, `"aac"`, and `"flac"` in addition to `wav` and `pcm`. Encoding is handled by `ffmpeg` on the server's `PATH`; if ffmpeg is absent, these formats return `503 transcode_unavailable`. Use `qvac doctor` to check availability.

Two new discovery endpoints are also available:

```
GET /v1/audio/voices  →  list of configured TTS voices
GET /v1/audio/models  →  list of loaded (READY) TTS models
```

## Bug Fixes

### Correct finish_reason and token accounting

`finish_reason: "length"` is now returned when generation is truncated by `max_tokens` or `max_completion_tokens` (previously always `"stop"`). The Responses API equivalent is `status: "incomplete"` with `incomplete_details.reason: "max_output_tokens"`. Token counts (`completion_tokens` / `output_tokens`) now consistently use the SDK's `generatedTokens` stats across `/v1/chat/completions`, `/v1/completions`, and `/v1/responses`.

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
import { sdkCompletion } from '@qvac/cli/serve/core/sdk'
import { bindClientDisconnectCancel } from '@qvac/cli/serve/core/cancel-bridge'

const run = sdkCompletion({/* ... */})
bindClientDisconnectCancel(req, res, run.requestId, logger)
const final = await run.final
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
  "data": [{ "b64_json": "iVBORw0KGgoAAAANSUhEUgAA..." }]
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
