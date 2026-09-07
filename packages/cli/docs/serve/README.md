# `qvac serve`

`qvac serve` runs a local HTTP server backed by QVAC models. The server itself is
surface-agnostic: it owns configuration, model loading, authentication, CORS and the
OpenAPI document, and mounts one or more **extensions** that contribute the actual routes.

| Extension | Flag               | Routes         | Reference                |
| --------- | ------------------ | -------------- | ------------------------ |
| `default` | mounted by default | `/qvac/v1/...` | [default.md](default.md) |
| `openai`  | `--openai`         | `/v1/...`      | [openai.md](openai.md)   |

```bash
qvac serve                        # the QVAC surface
qvac serve --openai               # QVAC + OpenAI-compatible
qvac serve --openai --no-default  # OpenAI-compatible only
```

`qvac serve openai` is a deprecated alias for the last form.

The OpenAPI document describes whatever is mounted. It is always at `/openapi.json`;
`--docs` additionally serves Swagger UI at `/docs`.

Configuration lives under `serve` in `qvac.config.*`. `serve.models`, `serve.load` and
`serve.cors` are server-wide and documented here; each extension reads its own
`serve.<name>` block, documented in that extension's page.

## Network security and CORS

The default `127.0.0.1` bind is unauthenticated. A non-loopback `--host` refuses to start without `--api-key <key>` or `--api-key-file <path>`; `--allow-unauthenticated` downgrades that refusal to a warning for operators who accept the exposure.

Prefer `--api-key-file`: `--api-key` places the token in the process's command line, which `/proc/<pid>/cmdline` exposes to every local account on Linux. The file must be a regular file, and the CLI warns when it is readable beyond its owner (`chmod 600`).

Browser access requires explicit trusted origins unless `--docs` enables its same-port loopback defaults. Repeat `--cors-origin` or configure `serve.cors.origins`; wildcard (`*`) is rejected:

```bash
qvac serve --openai \
  --api-key "$QVAC_API_KEY" \
  --cors-origin https://app.example.com \
  --cors-origin http://localhost:3000
```

The legacy `--cors` flag is only a compatibility validation switch: it does not enable CORS and fails unless at least one explicit CLI/config origin is supplied. `--cors --docs` also fails without one because docs defaults are added after that validation.

Independently, `--docs` adds same-port `localhost`, `127.0.0.1`, and `[::1]` origins for Swagger UI, plus the bound host's same-port origin when that host is itself loopback. Add any non-loopback or forwarded browser origin explicitly.

`/openapi.json`, `/docs`, and `/docs/*` are exempt from bearer authentication. `/openapi.json` is always public; the docs routes exist only with `--docs`. Do not enable docs on a non-loopback bind unless public introspection is acceptable.

## Model loading & lifecycle

Every model listed under `serve.models` is addressable by its alias. How and when
it loads depends on `preload`:

- `preload: true` — the model loads at server startup. The port stays closed
  until every preload model is ready, so the first request is fast.
- `preload: false` — the model loads lazily on the **first request** that names
  it (cold start). That first request blocks while the model loads; later
  requests are fast. Concurrent first requests share a single load.

`preload` defaults to `true` for constant-form entries (`{ "model": "…" }`) and
`false` for explicit `{ "src", "type" }` entries. To force a lazy model to warm
at startup, pass `--model <alias>` on the command line.

Loading is transparent: a request may name any configured alias whether or not it is
currently loaded. Unloading an alias frees its resources but keeps it configured, so the
next request loads it again. There is no "load" endpoint — send a normal request, or set
`preload: true`.

### Load management (`serve.load`)

Tune lazy-load behavior under `serve.load` in `qvac.config.*` (each has a CLI
flag override):

| Field                | Default | CLI flag                         | Meaning                                                                                                                                  |
| -------------------- | ------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `lazy`               | `true`  | `--no-lazy-load`                 | When `false`, requests never trigger a load; an unloaded model returns `503 model_not_loaded`. Only `preload: true` models serve.        |
| `concurrency`        | `1`     | `--load-concurrency <n>`         | Max simultaneous loads across different aliases. `1` mirrors startup preload and bounds memory when many models lazy-load under traffic. |
| `timeoutMs`          | `null`  | `--load-timeout <ms>`            | Per-load deadline. On expiry the load is cancelled and the request gets `503 model_load_timeout`. `null` = unbounded.                    |
| `cancelOnDisconnect` | `true`  | `--no-cancel-load-on-disconnect` | When `true`, a client disconnecting mid-load cancels the load — but only once no other request is still waiting on that same load.       |

```json
{
  "serve": {
    "load": { "lazy": true, "concurrency": 1, "timeoutMs": 600000, "cancelOnDisconnect": true },
    "models": { "my-llm": { "model": "QWEN3_600M_INST_Q4" } }
  }
}
```

## Model source constants in config

`serve.models[*].config` fields ending in `ModelSrc` accept SDK model constant
names, including fields inside nested objects. The CLI resolves those names to
the same `ModelConstant` objects accepted by the SDK. The snake-case
`upscaler.model_src` field follows the same rules except in video mode, where
the SDK ignores the entire `upscaler` block and the CLI leaves it unchanged:

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

These fields also accept full source URLs such as `registry://…` and filesystem
paths. Bare filenames remain unchanged for downstream filesystem resolution.
Unknown `CONSTANT_CASE` values are rejected with the full config path.

## Related references

For the broader coding-agent stack — `@qvac/ai-sdk-provider`, managed `qvac serve`, `@qvac/opencode-plugin`, models.dev, layer ownership, and release choreography — see [Agent Integrations](../../../../docs/architecture/AGENT-INTEGRATIONS.md). Use these files for CLI serve route/config details; use the agent integration reference when deciding whether behavior belongs in SDK, CLI, provider, plugin, docs, or models.dev.
