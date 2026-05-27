// Keys must match the OpenAPI spec's path templates (e.g. `{file_id}` not `{id}`).
const ROUTE_CAVEATS: Record<string, readonly string[]> = {
  'GET /v1/files': ['ephemeral in-memory store'],
  'POST /v1/files': ['ephemeral in-memory store'],
  'GET /v1/files/{file_id}': ['ephemeral in-memory store'],
  'GET /v1/files/{file_id}/content': ['ephemeral in-memory store'],

  'POST /v1/images/generations': ['response_format=url requires --public-base-url on the server'],
  'POST /v1/images/edits': ['response_format=url requires --public-base-url on the server'],

  'POST /v1/responses': [
    'in-memory store for retrieve/delete/input_items; not durable across restarts'
  ],
  'GET /v1/responses/{response_id}': ['in-memory only', 'X-QVAC-Stub: responses-volatile'],
  'DELETE /v1/responses/{response_id}': ['in-memory only', 'X-QVAC-Stub: responses-volatile'],
  'GET /v1/responses/{response_id}/input_items': ['in-memory only', 'X-QVAC-Stub: responses-volatile'],

  'POST /v1/audio/speech': ['response is raw audio bytes (wav/pcm/etc.)'],

  'GET /v1/vector_stores': ['in-memory metadata; survives process lifetime only'],
  'POST /v1/vector_stores': ['in-memory metadata; survives process lifetime only'],
  'GET /v1/vector_stores/{vector_store_id}': ['in-memory metadata; survives process lifetime only'],
  'POST /v1/vector_stores/{vector_store_id}': ['in-memory metadata; survives process lifetime only'],
  'DELETE /v1/vector_stores/{vector_store_id}': ['in-memory metadata; survives process lifetime only'],
  'POST /v1/vector_stores/{vector_store_id}/search': ['in-memory metadata; survives process lifetime only'],
  'POST /v1/vector_stores/{vector_store_id}/files': ['in-memory metadata; survives process lifetime only']
}

export function collectMeta (): Map<string, string[]> {
  const map = new Map<string, string[]>()
  for (const [endpoint, caveats] of Object.entries(ROUTE_CAVEATS)) {
    map.set(endpoint, [...caveats])
  }
  return map
}
