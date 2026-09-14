/**
 * Tag-level descriptions shown as section headers in Swagger UI.
 * Per-route descriptions live next to each route's Fastify schema.
 */
export const TAG_DESCRIPTIONS: Record<string, string> = {
  'KV Cache':
    'Reclaim the automatic KV cache that chat requests build up on disk. It is bounded already (4 GiB LRU on desktop, 512 MiB on mobile, 24h idle TTL); this frees it on demand. Caller-owned named caches are never touched — those stay SDK-managed via `deleteCache({ kvCacheKey })`.',
  Translation:
    'Text translation via SDK `translate()` backed by an NMT model. Each alias under `serve.models` configures its own engine and language direction.'
}
