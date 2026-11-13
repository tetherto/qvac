# QVAC CLI v0.19.0 Release Notes

📦 **NPM:** https://www.npmjs.com/package/@qvac/cli/v/0.19.0

QVAC CLI 0.19.0 moves to `@qvac/sdk@^0.24.0`. `qvac serve` now listens on port 11435 by default, gains runtime state and admin-gated suspend and resume routes, experimental world scene routes, and named KV cache sessions for `/v1/responses`, which also works with Codex requests. Model fit answers from per-device memory, and `qvac bundle sdk` packages the worker with bare-stow for desktop, phone, Pear and Python apps.

## Breaking Changes

### `qvac serve` listens on port 11435

The default port moves from 11434 to 11435, so it no longer collides with Ollama. Clients that relied on the default need the new port, or start the server on the old one.

**Before:**

```bash
qvac serve --openai   # http://127.0.0.1:11434/v1
```

**After:**

```bash
qvac serve --openai               # http://127.0.0.1:11435/v1
qvac serve --openai --port 11434  # previous behaviour
```

### `POST /qvac/v1/models/fit` reports per-device memory

The route follows the SDK's new model fit. The request body is strict: `execution` and `policy` are no longer accepted and answer `400`. The `invalid_execution` and `invalid_policy` error codes are removed, and `400 invalid_model_config` is added for a `config` the engine's schema refuses.

**Before:**

```jsonc
{ "models": [{ "model": "qwen9b" }], "execution": "concurrent" }
// → { "verdict": "likely-fits" | "likely-too-large" | "unknown", "basis", "evidence", "budget", "floorBytes", "reasons", ... }
```

**After:**

```jsonc
{ "models": [{ "model": "qwen9b" }] }
// → { "object": "model_fit", "verdict": "fits" | "does-not-fit" | "unknown",
//     "pools": [{ "id", "unified", "usedBytes", "freeBytes"?, "totalBytes"? }],
//     "models": [{ "model", "status", "devices": [...], "stats": { "ctxSize", "gpuLayers" } | {} }] }
```

### `/v1/responses` separates reasoning, and chat usage drops `cached_tokens`

`output[0]` of a `/v1/responses` answer is no longer always the `message` item. On a `<think>` model a `reasoning` item comes first, and a turn that only calls tools carries no empty `message` item. Find the item by `type` instead of by index. `usage.input_tokens` now reports the real prompt size; it was always `0`.

```jsonc
{
  "output": [
    {
      "type": "reasoning",
      "id": "rs_…",
      "summary": [],
      "content": [{ "type": "reasoning_text", "text": "…" }]
    },
    {
      "type": "message",
      "role": "assistant",
      "content": [{ "type": "output_text", "text": "answer only" }]
    }
  ],
  "usage": { "input_tokens": 120, "output_tokens": 7, "total_tokens": 127 }
}
```

On `/v1/chat/completions`, `usage.prompt_tokens_details.cached_tokens` is no longer sent.

### The MobileNet classifier alias names its model

The classifier weights are no longer bundled. An alias with `type` and no `src` fails with `serve.models.<alias>: "src" is required`.

**Before:**

```json
{ "serve": { "models": { "classifier": { "type": "ggml-classification" } } } }
```

**After:**

```json
{ "serve": { "models": { "classifier": { "model": "MOBILENETV3_3CLASS_V3_FP16" } } } }
```

### Bundling and `qvac doctor` follow the bare-stow worker

- Bundle again after upgrading. `qvac bundle sdk` writes the `qvac/worker/` folder and needs Node.js `^22.21.0 || >=24.9.0`.
- `qvac bundle sdk --host` defaults to this machine, or to every phone host for `--target react-native`. Pass `--host` for each other platform you ship.
- `qvac verify bundle` drops `--bare-runtime-version` and `--config`, `--json` reports one runtime per platform, and an `engines-mismatch` is a warning.
- `qvac doctor` reports the runtime check as `bare-sidecar-runtime` (was `bare-runtime`), and the failing addon case as `abi-mismatch`. Update scripts that match on these codes.

### Changes inherited from `@qvac/sdk` 0.24

- **No default system message.** A chat request with no system message reaches the model without one. Set `system_prompt` in the alias's `config` to keep "You are a helpful assistant.".
- **Text and media keep their order.** A user turn that mixes text and images reaches the model in the order sent, instead of images first.
- **EmbeddingGemma-300M constants changed files.** `EMBEDDINGGEMMA_300M_F32` is removed, and the other three constants resolve to the Dense-layer models. Re-ingest RAG workspaces built with the earlier files.
- **Remote RPC servers.** An alias with `rpc-servers` needs `@qvac/ggml-rpc-server` `^0.9.0` on the remote hosts.

## New APIs

### Runtime state, suspend and resume

`GET /qvac/v1/runtime/state` reads the lifecycle state, and `GET /qvac/v1/runtime/models` lists the aliases whose model is loaded. `POST /qvac/v1/runtime/suspend` and `POST /qvac/v1/runtime/resume` are admin-only: start the server with `--enable-admin`, or they answer `403 admin_disabled`. While the runtime is suspended every other route answers `503 runtime_suspended`.

```bash
qvac serve --enable-admin --api-key-file ./key
curl -sS -X POST http://localhost:11435/qvac/v1/runtime/suspend -H "Authorization: Bearer $KEY"
# { "object": "runtime.state", "state": "suspended" }
```

`--enable-admin` on a non-loopback host needs `--api-key` or `--api-key-file`, even with `--allow-unauthenticated`.

### World scenes (experimental)

`POST /qvac/v1/world/scenes` creates an interactive scene from a first frame, `POST /qvac/v1/world/scenes/:id/steps` advances it with held keys, and `GET /qvac/v1/world/scenes/:id` reads it.

```bash
curl -sS localhost:11435/qvac/v1/world/scenes \
  -F model=abot-world -F prompt='| unknown | A forest path' -F image=@first-frame.jpg
# → 201 { "id": "scene_…", "object": "world.scene", "status": "active", … }

curl -sS localhost:11435/qvac/v1/world/scenes/scene_…/steps \
  -H 'Content-Type: application/json' -d '{"keys":["W"]}'
```

### Named KV cache sessions for `/v1/responses`

A Responses request can name the prompt cache it continues, so a long conversation is not re-evaluated each turn. Send `prompt_cache_key` in the body, the `X-QVAC-KV-Cache-Key` header, or `metadata.qvac_kv_cache_key`. `DELETE /qvac/v1/kv_cache` also clears these caches.

```jsonc
// POST /v1/responses
{ "model": "qwen9b", "input": "…", "prompt_cache_key": "conversation-1" }
// → usage: { "input_tokens": 2568, "qvac_cache_tokens": 2569, "output_tokens": 1, "total_tokens": 2569 }
```

### `/v1/responses` works with Codex requests

Tool types the server does not run, such as `web_search`, are skipped instead of rejected. `namespace` tools are flattened and their calls come back with the `namespace` split out again. Input items shaped `{ "role", "content" }` are accepted without `type`, `system` and `developer` turns are merged into one leading `system` turn, and a context overflow ends a stream with a `response.failed` event carrying `context_length_exceeded`.

### Transcription, speech and registry routes

- `POST /v1/audio/transcriptions` with `verbose_json` carries `language`, and per segment `no_speech_prob`, `speaker_turn_next` and `token_timestamps` when the whisper engine reports them.
- `POST /v1/audio/speech` forwards `instructions` to a CosyVoice3 alias as its style instruction.
- The registry routes answer `503 registry_busy` when another process holds the registry store.
- Alias `config` accepts the new SDK load options for whisper, Parakeet, text-to-speech and MOSS-Image, and resolves a model constant name in every `*Src` key.

### Bundling targets

`qvac bundle sdk --target <bare-sidecar|react-native|pear-runtime> --language <javascript|python>` packages the SDK worker for a desktop app, a phone app, a Pear app or a Python app.

## Bug Fixes

Close, bundle, verify and host-transport defects in the bare-stow worker are fixed.
