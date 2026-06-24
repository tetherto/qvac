import { createOpenAICompatible } from '@ai-sdk/openai-compatible'

import { DEFAULT_API_KEY, DEFAULT_BASE_URL, DEFAULT_HEADERS } from './defaults.js'
import type {
  ManagedQvacProvider,
  QvacExternalOptions,
  QvacManagedOptions,
  QvacOptions,
  QvacProvider
} from './types.js'

// External mode: a thin, synchronous wrapper around `createOpenAICompatible`
// pointed at a `qvac serve openai` endpoint the caller runs themselves. This is
// the v1 behaviour, kept byte-for-byte identical.
export function createExternalQvac (options: QvacExternalOptions = {}): QvacProvider {
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

export function createQvac (options?: QvacExternalOptions): QvacProvider
export function createQvac (options: QvacManagedOptions): Promise<ManagedQvacProvider>
export function createQvac (options: QvacOptions = {}): QvacProvider | Promise<ManagedQvacProvider> {
  if (options.mode === 'managed') {
    // Lazy import keeps the supervisor (and its `node:child_process` /
    // `node:net` / `@qvac/cli` resolution) out of the module graph for the
    // common external-mode path, so those users pay no startup or install cost.
    return import('./managed/index.js').then((m) => m.startManagedQvac(options))
  }
  return createExternalQvac(options)
}

export const qvac: QvacProvider = createQvac()
