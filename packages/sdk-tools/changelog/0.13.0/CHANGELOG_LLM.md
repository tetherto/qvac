# QVAC CLI v0.13.0 Release Notes

📦 **NPM:** https://www.npmjs.com/package/@qvac/cli/v/0.13.0

`qvac serve` becomes a host for mounted surfaces rather than a single OpenAI server, so the QVAC-native API and the OpenAI-compatible API can run together or apart. Translation is now a served endpoint, `qvac configure` prompts for every model type instead of only llamacpp, and worker startup failures finally report the reason they failed. This release also clears a HIGH-severity advisory reachable through the `/docs` route.

## Breaking Changes

### `qvac serve` now serves the QVAC surface by default

`qvac serve` used to print help and do nothing; the only real server was `qvac serve openai`. Serving is now the default, and the OpenAI-compatible surface is a flag rather than a subcommand.

**Before:**

```bash
qvac serve            # prints help
qvac serve openai     # serves /v1/*
```

**After:**

```bash
qvac serve                          # serves the QVAC surface only
qvac serve --openai                 # QVAC + /v1/*
qvac serve --openai --no-default    # /v1/* only
```

`qvac serve openai` still works, keeps every flag it had, and behaves identically — it prints a deprecation warning on start. Migrate by replacing the `openai` subcommand with `--openai --no-default` if you want the previous surface set exactly.

`qvac openai spec` emits the same paths, schemas, and tags as before. Two `info` fields change, because the document now names the surfaces it mounts:

```
BEFORE: "title": "QVAC OpenAI-compatible API"
        "description": "OpenAI-compatible REST API served by `qvac serve openai`."
AFTER:  "title": "QVAC API"
        "description": "Mounted surfaces: openai (OpenAI-compatible REST API)."
```

Configuration is unchanged: `serve.models` and every existing key keep their meaning. OpenAI-specific keys move under `serve.openai`, and an unknown `serve.*` key now logs a warning instead of being dropped in silence.

## New APIs

### Text translation over HTTP

The QVAC surface serves translation at `POST /qvac/v1/translate`. Configure a translation model the same way as any other served model:

```json
// qvac.config.json
{
  "serve": {
    "models": {
      "de-en": {
        "model": "BERGAMOT_DE_EN",
        "config": { "engine": "Bergamot", "from": "de", "to": "en" }
      }
    }
  }
}
```

```bash
curl localhost:11434/qvac/v1/translate \
  -H 'content-type: application/json' \
  -d '{ "model": "de-en", "text": ["Guten Morgen", "Vielen Dank"] }'
```

```json
{
  "object": "translation",
  "model": "de-en",
  "translations": ["Good morning", "Thank you very much"]
}
```

Batches stream item by item when you ask for a stream, so long batches report progress instead of blocking to the end:

```
data: {"object":"translation.item","index":0,"text":"Good morning", ...}
data: {"object":"translation.item","index":1,"text":"Thank you very much", ...}
data: {"object":"translation.done", ...}
data: [DONE]
```

## New Configuration

### Worker handshake timeout is configurable, and startup failures say why

A worker that never completed its RPC handshake produced `RPC_INIT_TIMEOUT` and nothing else — no way to tell a slow cold start from a worker that died on a missing native library. The timeout is now tunable, and every pre-handshake failure carries a typed cause:

```json
// qvac.config.json
{ "rpcInitTimeoutMs": 120000 }
```

```bash
# Takes precedence over the config file, and also raises `qvac doctor`'s probe
QVAC_RPC_INIT_TIMEOUT_MS=120000 qvac serve
```

The typed cause distinguishes the two cases that used to look identical — a worker that exited (raising the timeout will not help) from one that is still running but never connected (a longer timeout may help) — and carries the worker's stderr tail.

## Improvements

### `qvac configure` prompts for every model type

Schema-driven prompts previously covered only llamacpp chat and embedding entries; every other model type fell back to a generic entry you had to finish by hand. `qvac configure` now reads each model type's config schema from the SDK, so type hints, field descriptions, and per-field validation come from the same source the runtime validates against — for all model types, including addons added after this release.

## Bug Fixes

### Preload failures report the real cause, and can refuse to start

On a preload failure `qvac serve` logged only `err.message` (for example "RPC initialization timed out") and discarded `err.cause`, which is where the worker stderr — the actual reason, such as a missing addon or a bad `.so` — lives. The full error cause chain is now logged.

With lazy loading off, preloaded models are the only ones that can serve, yet the server still opened its port when every preload had failed: healthy-looking, serving nothing. `--no-lazy-load` now exits non-zero if every preload model fails. With lazy loading on (the default) the server still starts, because a failed preload retries on the next request, so ordinary and mixed configurations are unaffected.

### A model lazy-loaded over a POST body can now load at all

With `cancelOnDisconnect` on (the default), the first request that lazy-loaded a model through a POST body was cancelled before the load began, returning `503 model_load_failed` ("cancelled before start"). The load left the model unloaded, so every retry hit the same path and such a model could never load.

The disconnect check watched the request stream, which closes as soon as the body is read — and Fastify reads the body before the load starts, so the abort fired immediately. It now watches the response stream, which closes only when the client actually disconnects during the load. A real mid-load disconnect still cancels the in-flight load.

### `qvac serve` builds again

`serve/lib/tool-dialect.ts` still read `isDelegated` from loaded-model info, a field removed when delegated inference was dropped from the SDK, which broke typecheck and build. The stale guard is gone.

## Security

### HIGH-severity advisory cleared on the `/docs` route

`serve --docs` serves Swagger UI through `@fastify/static`, pulled in transitively by `@fastify/swagger-ui@5`, which resolved to a vulnerable version. That exposed [GHSA-83w8-p2f5-377r](https://github.com/advisories/GHSA-83w8-p2f5-377r) (route-guard bypass via path traversal, HIGH, CVSS 7.5) and [GHSA-8pvw-jcv7-9cmj](https://github.com/advisories/GHSA-8pvw-jcv7-9cmj) (authorization bypass, moderate) through the `/docs` route.

`@fastify/swagger-ui` moves to `^6.1.1`, which depends on `@fastify/static ^10.1.0` — past both fix versions — and `fastify-plugin` moves to `^6` to match that chain and avoid a duplicate install. There are no source changes; `npm audit` reports zero vulnerabilities after the bump.

## Requirements

This release requires `@qvac/sdk@^0.19.0`. Both the configurable handshake timeout and `qvac configure`'s schema-driven prompts for every model type read APIs that 0.19.0 is the first SDK release to export.
