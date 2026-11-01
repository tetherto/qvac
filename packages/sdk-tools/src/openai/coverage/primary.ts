/**
 * Primary AI surface — endpoints that real AI agents and OpenAI-compatible
 * clients actually call. Union of footprints across surveyed clients
 * (OpenClaw is one such example; this set is intended to grow as additional
 * clients are folded in).
 *
 * Distinct from the spec-derived "primary-ai" category, which marks the whole
 * inference surface regardless of demonstrated client demand.
 */
export const CONSUMER_PRIMARY_ENDPOINTS = new Set<string>([
  'POST /v1/responses',
  'POST /v1/chat/completions',
  'POST /v1/embeddings',
  'POST /v1/images/generations',
  'POST /v1/images/edits',
  'POST /v1/audio/speech',
  'POST /v1/audio/transcriptions',
  'POST /v1/realtime/sessions',
  'POST /v1/realtime/client_secrets',
  'POST /v1/realtime/transcription_sessions',
  'POST /v1/videos',
  'POST /v1/videos/edits'
])
