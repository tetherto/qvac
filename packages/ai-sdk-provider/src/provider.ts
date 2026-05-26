import { createOpenAICompatible } from '@ai-sdk/openai-compatible'

import { DEFAULT_API_KEY, DEFAULT_BASE_URL, DEFAULT_HEADERS } from './defaults.js'
import type { QvacOptions, QvacProvider } from './types.js'

export function createQvac (options: QvacOptions = {}): QvacProvider {
  const headers = { ...DEFAULT_HEADERS, ...options.headers }
  const init: Parameters<typeof createOpenAICompatible>[0] = {
    name: 'qvac',
    baseURL: options.baseURL ?? DEFAULT_BASE_URL,
    apiKey: options.apiKey ?? DEFAULT_API_KEY,
    headers
  }
  if (options.fetch !== undefined) init.fetch = options.fetch
  return createOpenAICompatible(init) as QvacProvider
}

export const qvac: QvacProvider = createQvac()
