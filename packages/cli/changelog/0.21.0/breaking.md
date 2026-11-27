# 💥 Breaking Changes v0.21.0

## Judge model fit on shared memory and report why a fit is unknown

PR: [#5860](https://github.com/tetherto/qvac/pull/5860)

`POST /qvac/v1/models/fit` now applies the shared-pool check to each model on its own. A model whose rows share one memory pool, such as a Metal GPU or an integrated GPU plus the CPU, is `does-not-fit` when those rows together take more than 90% of the pool's free memory, even when each row fits. A single model's `verdict` is its `status`, so such a request changes from `fits` to `does-not-fit`. A row alone in its pool, such as a discrete GPU, keeps the engine's answer.

**BEFORE:**

```jsonc
// POST /qvac/v1/models/fit, one model whose Metal and CPU rows each fit
{ "object": "model_fit", "verdict": "fits", "models": [{ "model": "my-llm", "status": "fits" }] }
```

**AFTER:**

```jsonc
{
  "object": "model_fit",
  "verdict": "does-not-fit",
  "models": [
    {
      "model": "my-llm",
      "status": "does-not-fit",
      "reason": "devices sharing one pool need more than 90% of its free memory: host 19642 MiB of 18104 MiB free"
    }
  ]
}
```

An alias loaded with `modelFitPolicy: 'refuse'` is refused under the same rule.

---

## Remove the RAG API from the SDK and inference

PR: [#5874](https://github.com/tetherto/qvac/pull/5874)

The SDK no longer has a RAG API, so `/v1/vector_stores` on `qvac serve --openai` now stores and searches files with `@qvac/rag` directly. The routes and their request and response shapes are the same. What changes:

- **Existing vector stores are not carried over.** Stores created with CLI 0.20.x or earlier are not listed or searched. Create the store again and attach its files. The old data stays in `rag-hyperdb` and `rag-turbovec` next to the cache directory until you delete those folders.
- **Stores live in a new place.** Each store has a folder under `serve/vector-stores` next to the SDK `cacheDirectory`, which is `~/.qvac/serve/vector-stores` by default.
- **A store is open in one server at a time.** While another server on the same data directory has the store open, search, attach and delete return `409 vector_store_in_use`.
- **`embedding_model_mismatch` covers the weights.** A store is tied to the embedding weights and the `pooling`, `attention` and `embdNormalize` settings it was ingested with, not only to the alias name. Pointing the alias at other weights returns `400 embedding_model_mismatch`.

**BEFORE:**

```bash
# A store that had files attached under 0.20.x
curl -sS http://localhost:11435/v1/vector_stores/vs_abc123/search \
  -H "Content-Type: application/json" -d '{"query": "install"}'
# 200, hits from the files attached earlier
```

**AFTER:**

```bash
# 0.21.0 does not read that store
curl -sS http://localhost:11435/v1/vector_stores/vs_abc123/search \
  -H "Content-Type: application/json" -d '{"query": "install"}'
# 404 vector_store_not_found: create a store with POST /v1/vector_stores,
# upload each file with POST /v1/files, and attach it with POST /v1/vector_stores/{id}/files
```

---

## Report full prompt usage and standard statuses to coding agents

PR: [#5931](https://github.com/tetherto/qvac/pull/5931)

- `POST /v1/responses`: a response in which the model called tools has `status: "completed"`. It used to be `requires_action`, which is not a Responses API status, and the response no longer carries `required_action`. Read the calls from the `function_call` items in `output`.
- `POST /v1/chat/completions`: `usage.prompt_tokens` counts the whole prompt. On a KV cache hit it used to count only the newly read tokens. The part the cache already held is in `usage.prompt_tokens_details.cached_tokens`.
- `POST /v1/responses` reports the cached part the same way, in `usage.input_tokens_details.cached_tokens`.

**BEFORE:**

```jsonc
// POST /v1/responses, model called a tool
{ "status": "requires_action", "required_action": { "type": "submit_tool_outputs" }, "usage": { "input_tokens": 262 } }
// POST /v1/chat/completions, cache hit on a 262-token prompt
{ "usage": { "prompt_tokens": 14, "total_tokens": 20 } }
```

**AFTER:**

```jsonc
{ "status": "completed", "usage": { "input_tokens": 262, "input_tokens_details": { "cached_tokens": 248 } } }
{ "usage": { "prompt_tokens": 262, "prompt_tokens_details": { "cached_tokens": 248 }, "total_tokens": 268 } }
```

---
