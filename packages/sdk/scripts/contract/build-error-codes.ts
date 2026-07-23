import { SDK_SERVER_ERROR_CODES } from '@/schemas/sdk-errors-server'
import { SDK_CLIENT_ERROR_CODES } from '@/schemas/sdk-errors-client'
import { REGISTRY_ERROR_CODES } from '@/schemas/sdk-errors-registry'

/**
 * JSON export of the SDK error-code registries (name → numeric code) for the
 * server, client, and registry error families. The Python client's typed
 * error classes and its RPC-boundary reconstructor read these instead of
 * hand-copying the numbers, so a code added or renamed on the SDK side surfaces
 * as a `contract:check` / `generate.py --check` failure rather than a Python
 * client that silently can't reconstruct a server error.
 *
 * A separate artifact from schema.json, like models.json / model-type-maps.json.
 */
export interface ErrorCodes {
  server: Record<string, number>
  client: Record<string, number>
  registry: Record<string, number>
}

function sortedEntries(record: Record<string, number>): Record<string, number> {
  const entries = Object.entries(record)
  entries.sort(function (a, b) {
    return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0
  })
  return Object.fromEntries(entries)
}

export function buildErrorCodes(): ErrorCodes {
  return {
    server: sortedEntries(SDK_SERVER_ERROR_CODES),
    client: sortedEntries(SDK_CLIENT_ERROR_CODES),
    registry: sortedEntries(REGISTRY_ERROR_CODES)
  }
}
