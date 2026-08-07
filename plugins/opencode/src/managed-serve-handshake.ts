import { HostInvalidHandshakeError } from './errors.js'

export interface HostListening {
  readonly apiKey: string
  readonly baseURL: string
  readonly modelId: string
  readonly modelName: string
}

const MANAGED_API_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/

export function parseHostListening(raw: string): HostListening {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new HostInvalidHandshakeError('payload is not valid JSON', err)
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new HostInvalidHandshakeError('payload must be an object')
  }

  const value = parsed as Record<string, unknown>
  if (typeof value['apiKey'] !== 'string' || !MANAGED_API_KEY_PATTERN.test(value['apiKey'])) {
    throw new HostInvalidHandshakeError('apiKey is missing or invalid')
  }
  if (
    typeof value['baseURL'] !== 'string' ||
    typeof value['modelId'] !== 'string' ||
    typeof value['modelName'] !== 'string'
  ) {
    throw new HostInvalidHandshakeError('provider metadata is missing or invalid')
  }

  return {
    apiKey: value['apiKey'],
    baseURL: value['baseURL'],
    modelId: value['modelId'],
    modelName: value['modelName']
  }
}

export function createManagedProviderConfig(listening: HostListening, timeout: number) {
  return {
    npm: '@ai-sdk/openai-compatible',
    name: 'QVAC (local, managed)',
    options: { baseURL: listening.baseURL, apiKey: listening.apiKey, timeout },
    models: {
      [listening.modelId]: {
        name: `${listening.modelName} (local)`,
        tool_call: true,
        reasoning: true
      }
    }
  }
}
