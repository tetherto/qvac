/**
 * Tag-level descriptions shown as section headers in Swagger UI.
 * Per-route descriptions live next to each route's Fastify schema in
 * `routes/<domain>.ts` (the standard `schema.description` field).
 */
export const TAG_DESCRIPTIONS: Record<string, string> = {
  Chat: 'OpenAI-compatible chat completions backed by SDK `completion()`. Supports streaming SSE, tool calls, and JSON-schema response format.',
  Completions: 'Legacy text completions endpoint. Multi-prompt + streaming combinations are rejected.',
  Embeddings: 'Text embeddings via SDK `embed()`. Single string or array of strings.',
  Responses: 'OpenAI Responses API. **Server-side storage is in-memory only** — IDs expire on restart (60-minute TTL, 256 max entries). All `/v1/responses*` replies carry the `X-QVAC-Stub: responses-volatile` header.',
  Audio: '`/audio/transcriptions` and `/audio/translations` are multipart/form-data; `/audio/speech` returns raw audio bytes (wav/pcm/etc.) with `X-Audio-*` headers.',
  Images: 'Stable Diffusion-style image generation. `response_format=url` requires the server to be started with `--public-base-url`.',
  Videos: 'Async text-to-video generation backed by SDK `video({ mode: "txt2vid" })`. POST creates a job (returns immediately with `status: queued`); poll `GET /v1/videos/{id}` then fetch bytes from `GET /v1/videos/{id}/content`. **Job store is in-memory only** — jobs and rendered bytes are lost on restart.',
  Files: '**Ephemeral in-memory store.** Uploaded files are dropped from the store on successful attach to a vector store. Not durable across restarts.',
  'Vector Stores': '**In-memory metadata; survives process lifetime only.** The underlying RAG workspace data persists via the SDK\'s RAG layer, but the OpenAI-shaped metadata (name, expires_after, etc.) is lost on restart.',
  Models: 'Lifecycle for models registered under `serve.models` in the config. DELETE unloads the model.'
}
