/**
 * Tag-level descriptions shown as section headers in Swagger UI.
 * Per-route descriptions live next to each route's Fastify schema.
 */
export const TAG_DESCRIPTIONS: Record<string, string> = {
  'Chat Batch':
    'Several chat prompts decoded together on one LLM via SDK `batchCompletion()`. Each prompt takes the `/v1/chat/completions` fields.',
  'KV Cache':
    'Reclaim the automatic KV cache that chat requests build up on disk. It is bounded already (4 GiB LRU on desktop, 512 MiB on mobile, 24h idle TTL); this frees it on demand. Caller-owned named caches are never touched — those stay SDK-managed via `deleteCache({ kvCacheKey })`.',
  System:
    "The host's capacity, and whether models are likely to fit in its memory before they are loaded. Advisory: nothing is reserved, and no load is refused on this basis.",
  Translation:
    'Text translation via SDK `translate()` backed by an NMT model. Each alias under `serve.models` configures its own engine and language direction.',
  OCR: 'Text recognition via SDK `ocr()`. Each alias under `serve.models` configures its own pipeline and languages.'
}
