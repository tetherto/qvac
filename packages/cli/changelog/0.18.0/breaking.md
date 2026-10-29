# 💥 Breaking Changes v0.18.0

## Context overflow returns 400 context_length_exceeded

PR: [#4834](https://github.com/tetherto/qvac/pull/4834)

**BEFORE:**

```json
// HTTP 500
{ "error": { "type": "server_error", "code": "internal_error", "message": "..." } }
```

**AFTER:**

```json
// HTTP 400
{
  "error": {
    "code": "context_length_exceeded",
    "type": "invalid_request_error",
    "message": "The request exceeds the model's context capacity. Shorten the input, start a new conversation, or increase ctx_size."
  }
}
```

A streaming response that overflows mid-stream sends the same envelope as an SSE error frame. Any other unexpected mid-stream error now says `An internal error occurred.` instead of repeating the raw SDK message.

---

## Paging errors have their own codes

PR: [#5356](https://github.com/tetherto/qvac/pull/5356)

An invalid `limit` or `offset` on `/v1/models/catalog`, `/v1/videos` and the Responses `input_items` list returns `400 invalid_limit` or `400 invalid_offset` instead of `400 invalid_request`. Clients that match on `invalid_request` for these parameters need to match the new codes.

---

## /v1/images/edits forwards every uploaded image

PR: [#5302](https://github.com/tetherto/qvac/pull/5302)

**BEFORE:** with several `image` or `image[]` files, the first was used and the rest were ignored with a warning.

**AFTER:** every file is forwarded in upload order as SDK `init_images`, and the model must support multiple references. A single file still uses `init_image`. Send one image to a single-reference model.

---

## Deferred tools with reserved or clashing names are not offered

PR: [#5346](https://github.com/tetherto/qvac/pull/5346)

A deferred tool is no longer offered or loaded if its name is empty, is `auto`, `none` or `required`, or collides with an eager tool, `tool_search` or an earlier deferred tool once characters outside `A-Za-z0-9-` fold to `-`. Rename such tools. Tools loaded by a search are now declared in the next round's tools block, so that round runs under the tool grammar.

---

## Changes inherited from @qvac/sdk 0.23

CLI 0.18.0 requires `@qvac/sdk ^0.23.0`. These SDK changes reach `qvac serve` users:

- **`pooling: "rank"` is rejected.** An embedding alias whose config sets `pooling: "rank"` now fails validation. Remove the field.
- **Remote RPC servers must speak protocol 112.** An alias with `rpc-servers` only works with `@qvac/ggml-rpc-server` 0.7.x on the remote hosts; protocol 111 servers are rejected.
- **The model fit runs inside the worker.** Load-time fit checks and `POST /qvac/v1/models/fit` run in the SDK worker. If the fitter crashes, the worker and every model it holds go down with it.
- **One image or video generation per model.** A second concurrent generation on the same alias is rejected with `429 request_rejected_by_policy`.

---
