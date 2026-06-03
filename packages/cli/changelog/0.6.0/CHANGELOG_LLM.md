# Changelog v0.6.0

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
