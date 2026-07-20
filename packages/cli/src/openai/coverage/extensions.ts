/**
 * qvac-only endpoints that intentionally extend beyond the official OpenAI
 * spec (e.g. added for Open WebUI compatibility). Coverage is measured
 * against the upstream spec, so these are reported separately instead of
 * being treated as an "implemented but not in spec" error.
 */
export const QVAC_EXTENSION_ENDPOINTS = new Set<string>([
  'GET /v1/audio/models',
  'GET /v1/audio/voices'
])
