# QVAC CLI v0.18.0 Release Notes

📦 **NPM:** https://www.npmjs.com/package/@qvac/cli/v/0.18.0

QVAC CLI 0.18.0 moves to `@qvac/sdk@^0.23.0`. The QVAC surface of `qvac serve` gains OCR, image classification, image upscaling, music generation and editing, and read access to the live model registry. Context overflow now returns a client error instead of a server error, and failed streams close cleanly.

## Breaking Changes

### Context overflow returns `400 context_length_exceeded`

A request that does not fit the model's context used to fail as `500 internal_error`. It now returns `400 context_length_exceeded` with type `invalid_request_error`, so clients can tell a request that is too long from a server failure. A streaming response that overflows mid-stream sends the same envelope as an SSE error frame. Any other unexpected mid-stream error now reads `An internal error occurred.` instead of repeating the raw SDK message.

**Before:**

```json
// HTTP 500
{ "error": { "type": "server_error", "code": "internal_error", "message": "..." } }
```

**After:**

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

### Paging errors have their own codes

An invalid `limit` or `offset` on `/v1/models/catalog`, `/v1/videos` and the Responses `input_items` list returns `400 invalid_limit` or `400 invalid_offset` instead of `400 invalid_request`. Clients that match on `invalid_request` for these parameters need to match the new codes.

### `/v1/images/edits` forwards every uploaded image

With several `image` or `image[]` files, the server used to edit with the first and ignore the rest. It now forwards every file, in upload order, as SDK `init_images`, and the model must support multiple references. A single file still uses `init_image`, so send one image to a single-reference model.

### Deferred tools with reserved or clashing names are not offered

A deferred tool is no longer offered or loaded if its name is empty, is `auto`, `none` or `required`, or collides with an eager tool, `tool_search` or an earlier deferred tool once characters outside `A-Za-z0-9-` fold to `-`. Rename such tools.

### Changes inherited from `@qvac/sdk` 0.23

- **`pooling: "rank"` is rejected.** An embedding alias whose config sets `pooling: "rank"` now fails validation. Remove the field.
- **Remote RPC servers must speak protocol 112.** An alias with `rpc-servers` works only with `@qvac/ggml-rpc-server` 0.7.x on the remote hosts. Protocol 111 servers are rejected.
- **The model fit runs inside the worker.** Load-time fit checks and `POST /qvac/v1/models/fit` run in the SDK worker. If the fitter crashes, the worker and every model it holds go down with it.
- **One image or video generation per model.** A second concurrent generation on the same alias is rejected with `429 request_rejected_by_policy`.

## New APIs

### OCR

`POST /qvac/v1/ocr` reads text from a PNG, JPEG or BMP image sent as a multipart file, a base64 data URL or a `/v1/files` id. It returns text blocks with bounding boxes and confidence, and `stream: true` sends them as server-sent events.

```bash
curl -sS http://localhost:11434/qvac/v1/ocr -F model=ocr-en -F image=@receipt.png
# { "object": "ocr", "model": "ocr-en", "blocks": [{ "text": "...", "bbox": [...], "confidence": 0.98 }], "stats": { ... } }
```

### Image classification

`POST /qvac/v1/classifications` labels a PNG or JPEG image and returns the top results with their confidence. A `classification` alias can omit `src` to use the default classifier.

```bash
curl -sS http://localhost:11434/qvac/v1/classifications -F model=classifier -F image=@photo.jpg
# { "object": "classification", "model": "classifier", "results": [{ "label": "food", "confidence": 0.93 }, ...] }
```

### Image upscaling

`POST /qvac/v1/images/upscale` runs an ESRGAN upscaler over an image, up to four times, and answers in the `/v1/images` response shape.

```bash
curl -sS http://localhost:11434/qvac/v1/images/upscale \
  -F model=upscaler -F image=@photo.png -F repeats=1
```

### Music generation, editing and understanding

`/qvac/v1/audio/generations` and `/qvac/v1/audio/edits` start ACE-Step jobs that you can list, poll, download and delete. `/content` returns WAV, or mp3, flac, opus or aac when the system `ffmpeg` is available. `POST /qvac/v1/audio/understandings` describes a recording with a caption, tempo, key, time signature and language. Jobs are kept in memory, so they do not survive a restart.

```bash
curl -sS http://localhost:11434/qvac/v1/audio/generations -H 'Content-Type: application/json' \
  -d '{ "model": "music", "caption": "calm lofi piano", "lyrics": "[Instrumental]", "duration": 30 }'

curl -sS "http://localhost:11434/qvac/v1/audio/generations/audiogen_…/content?format=mp3" -o song.mp3
```

### Live model registry

`GET /qvac/v1/registry/models` lists registry models with search, addon, engine and quantization filters and paging. `GET /qvac/v1/registry/models/lookup` fetches one entry by `registrySource` and `registryPath`, and returns `404 model_not_found` when the registry has no such model.

```bash
curl -sS "http://localhost:11434/qvac/v1/registry/models?addon=llm&search=qwen3&limit=1"
```

### Memory fit for ESRGAN and ABot world models

Load-time fit checks and `POST /qvac/v1/models/fit` now cover ESRGAN upscalers and ABot world sessions. A world alias can set `world.fitSteps` (default 100) for the walk length the estimate assumes.

### Multi-reference image edits

Models with multi-reference support, such as FLUX.2 and Qwen-Image-2.1, take several reference images on `/v1/images/edits`.

```bash
curl -sS http://127.0.0.1:11434/v1/images/edits \
  -F "image[]=@reference-a.png" \
  -F "image[]=@reference-b.png" \
  -F "model=my-diffusion" \
  -F "prompt=Place the referenced subjects together in one scene."
```

## Bug Fixes

### Failed streams close cleanly

Errors raised before a stream's headers are sent now return a normal HTTP error instead of a hung or closed socket, and nothing is written after the client disconnects.

### Clearer model load failures

`503 model_load_failed` now summarizes why the worker did not start: its exit code or signal, or that it did not connect before the startup timeout. The full chain, including the worker's stderr, stays in the server log.

### Parameter values stay out of warnings

The warnings `qvac serve` logs for unsupported parameters no longer print the values that were sent.

### Tool search rounds use the tool grammar

Tools loaded by `tool_search` are now declared in the next round's tools block, so that round's tool calls are constrained by the tool grammar.
