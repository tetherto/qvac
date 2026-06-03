# 🔌 API Changes v0.6.0

## Add live OpenAI coverage reporting to CLI

PR: [#2103](https://github.com/tetherto/qvac/pull/2103)

```bash
# Full report (live spec fetch, cached under ~/.cache/qvac/)
qvac openai coverage

# Filters
qvac openai coverage --primary-ai          # spec inference surface
qvac openai coverage --consumer-primary    # consumer-demanded endpoints
qvac openai coverage --unsupported
qvac openai coverage --unknown             # unmapped spec labels only
qvac openai coverage --json
qvac openai coverage --offline               # use cached spec only
```

---

## Resolve SDK from hoisted node_modules in cli bundler

PR: [#2140](https://github.com/tetherto/qvac/pull/2140)

```bash
$ cd apps/mobile           # @qvac/sdk hoisted to ../../node_modules/@qvac/sdk
$ qvac bundle sdk
❌ Bundle Error: bare-imports.json not found at .../node_modules/@qvac/sdk/...
```

```bash
$ cd apps/mobile
$ qvac bundle sdk
✅ Bundle generated successfully
```

```bash
$ qvac bundle sdk
❌ SDK Error: @qvac/sdk not found in any ancestor node_modules from <projectRoot>.
   Run `bun install` (or `npm install`) at your project root, or pass `--sdk-path <path>`.
```

---

## Rewrite serve HTTP layer on Fastify + Zod

PR: [#2306](https://github.com/tetherto/qvac/pull/2306)

Every route's Zod schema feeds `@fastify/swagger`, so the OpenAPI document stays in sync with what the server actually validates.

- `GET /openapi.json` — always exposed (no flag). Returns the full OpenAPI 3.1.0 document.
- `GET /docs` — Swagger UI, opt-in via `qvac serve openai --docs` (off by default to keep the prod surface minimal).

New CLI command — emit the spec without starting the server:

```sh
qvac openai spec                       # JSON → stdout (pipe-safe)
qvac openai spec -o spec.json          # write JSON to file
qvac openai spec --yaml                # YAML → stdout
qvac openai spec --yaml -o spec.yaml   # write YAML to file
```

Interactive browsing — start the server with `--docs`:

```sh
qvac serve openai --docs
open http://localhost:11434/docs
```

---

## Add OpenAI-compatible /v1/videos (txt2vid, async)

PR: [#2367](https://github.com/tetherto/qvac/pull/2367)

```http
POST /v1/videos
Content-Type: application/json

{
  "model": "wan-t2v",
  "prompt": "a colorful bird flapping its wings",
  "size": "480x832",
  "seconds": "2",
  "fps": 16,
  "steps": 30,
  "cfg_scale": 6.0,
  "flow_shift": 3.0,
  "negative_prompt": "blurry, low quality, static",
  "seed": 42
}

→ 200
{
  "id": "video_8f3a…",
  "object": "video",
  "model": "wan-t2v",
  "status": "queued",
  "progress": 0,
  "created_at": 1748800000,
  "completed_at": null,
  "expires_at": 253402300799,
  "prompt": "a colorful bird flapping its wings",
  "size": "480x832",
  "seconds": "2",
  "remixed_from_video_id": null,
  "error": null
}
```

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

---
