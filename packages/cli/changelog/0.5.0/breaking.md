# 💥 Breaking Changes v0.5.0

## Add POST /v1/images/edits to OpenAI adapter

PR: [#2032](https://github.com/tetherto/qvac/pull/2032)

`response_format=url` on `/v1/images/generations` no longer falls back to a `data:image/png;base64,…` URL. Existing callers must either pass `response_format=b64_json` (or omit the field — `b64_json` is the default), or run the server with `--public-base-url <origin>` (or `serve.publicBaseUrl` in the config), in which case the URL is now an absolute, fetchable HTTPS URL backed by `GET /v1/files/{id}/content`. If neither condition holds, the route now returns `400 unsupported_response_format` with an instructive message instead of a misleading `data:` URL.

A `mask` / `mask[]` part on `/v1/images/edits` is now rejected with `400 mask_not_supported` (no mask channel in the diffusion engine). The full loud-fail surface (`unsupported_output_format`, `unsupported_output_compression`, `unsupported_background`, `invalid_strength`, `unsupported_response_format`, `mask_not_supported`) is documented in `packages/cli/docs/serve-openai.md` and exercised in the bats suite.

**BEFORE:**

```json
// 0.4.x: response_format=url, no --public-base-url configured
{
  "created": 1718000000,
  "data": [
    { "url": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA..." }
  ]
}
```

**AFTER:**

```json
// 0.5.0 (option A): response_format=url, no --public-base-url -> 400
{
  "error": {
    "code": "unsupported_response_format",
    "message": "response_format=\"url\" requires the server to be started with --public-base-url ..."
  }
}
```

```json
// 0.5.0 (option B): response_format=url, server started with --public-base-url
{
  "created": 1718000000,
  "output_format": "png",
  "data": [
    {
      "url": "https://api.example.com/v1/files/file-abcd.../content",
      "expires_at": 1718003600
    }
  ]
}
```

---

## CLI cancel bridge + cancelHandler retirement

PR: [#2074](https://github.com/tetherto/qvac/pull/2074)

Two public-API `cancel(...)` call shapes are removed from `@qvac/sdk` in 0.11.0 (which `@qvac/cli` now depends on via `^0.11.0`). They never carried a `requestId` and therefore can't be mechanically back-mapped onto the new wire envelope — callers must migrate to the `requestId`-targeted cancel path (for `downloadAsset`) or the broad-cancel-by-`modelId` escape hatch (for `rag`).

### `cancel({ operation: "downloadAsset", downloadKey, clearCache })` removed

The replacement is the `requestId` exposed synchronously on the decorated promise returned by `downloadAsset(...)`. The `clearCache` flag is honoured on the `requestId` path.

**BEFORE:**

```typescript
import { downloadAsset, cancel } from "@qvac/sdk";

const op = downloadAsset({ assetSrc, onProgress });
// ...some time later, user clicks Cancel:
await cancel({ operation: "downloadAsset", downloadKey: assetSrc.key, clearCache: true });
```

**AFTER:**

```typescript
import { downloadAsset, cancel } from "@qvac/sdk";

const op = downloadAsset({ assetSrc, onProgress });
// `op.requestId` is available synchronously on the decorated promise:
await cancel({ requestId: op.requestId, clearCache: true });
```

### `cancel({ operation: "rag", workspace? })` removed

The three cancellable RAG operations (`ragIngest`, `ragSaveEmbeddings`, `ragReindex`) now return decorated promises in 0.11.0 — the `requestId` is exposed synchronously on the returned handle so callers can target a specific in-flight RAG op with `cancel({ requestId })`. The remaining RAG client APIs (`ragChunk`, `ragSearch`, `ragDeleteEmbeddings`, workspace lifecycle) intentionally do **not** decorate — they're fast-path operations that don't register with the server-side request registry. For "cancel everything RAG" sweeps without a `requestId` to hand, use the broad-cancel-by-`modelId` escape hatch.

**BEFORE:**

```typescript
import { ragIngest, cancel } from "@qvac/sdk";

ragIngest({ workspace: "my-workspace", documents });
// later:
await cancel({ operation: "rag", workspace: "my-workspace" });
```

**AFTER:** by `requestId` (primary path)

```typescript
import { ragIngest, cancel } from "@qvac/sdk";

const op = ragIngest({ workspace: "my-workspace", documents });
// `op.requestId` is available synchronously on the decorated promise:
await cancel({ requestId: op.requestId });
```

**AFTER:** broad cancel (escape hatch, no requestId to hand)

```typescript
import { cancel } from "@qvac/sdk";

// Cancel every in-flight RAG operation running on the embedding model:
await cancel({ modelId: ragEmbeddingModelId, kind: "rag" });
```

### Preserved (NOT breaking) — every other call shape still works

`normalizeCancelParams` translates the two most common legacy sugars to the new wire envelope at the client boundary:

```typescript
import { cancel } from "@qvac/sdk";

await cancel({ operation: "inference", modelId: "model-123" });   // -> {operation:"broad",modelId,kind:"completion"}
await cancel({ operation: "embeddings", modelId: "model-123" });  // -> {operation:"broad",modelId,kind:"embeddings"}
await cancel({ modelId: "model-123" });                            // new sugar (broad)
await cancel({ modelId: "model-123", kind: "completion" });        // new sugar (broad)
await cancel({ requestId: "rid-1" });                              // primary path
```

---
