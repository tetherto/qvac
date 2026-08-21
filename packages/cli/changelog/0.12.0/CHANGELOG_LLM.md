# QVAC CLI v0.12.0 Release Notes

📦 **NPM:** https://www.npmjs.com/package/@qvac/cli/v/0.12.0

This release makes `qvac serve openai` behave the way its model configuration always promised. Models marked `preload: false` now load on first use instead of failing forever, unloading a model is reversible, and a new catalog endpoint lets clients browse the models the SDK provides — not just the ones already configured. New flags and a `serve.load` config block let you tune or switch off that lazy loading.

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
