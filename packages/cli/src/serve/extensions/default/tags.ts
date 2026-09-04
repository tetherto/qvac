/**
 * Tag-level descriptions shown as section headers in Swagger UI.
 * Per-route descriptions live next to each route's Fastify schema.
 */
export const TAG_DESCRIPTIONS: Record<string, string> = {
  Translation:
    'Text translation via SDK `translate()` backed by an NMT model. Each alias under `serve.models` configures its own engine and language direction.'
}
