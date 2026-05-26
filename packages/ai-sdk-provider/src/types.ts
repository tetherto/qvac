import type { OpenAICompatibleProvider } from '@ai-sdk/openai-compatible'

export interface QvacOptions {
  readonly baseURL?: string
  readonly apiKey?: string
  readonly headers?: Record<string, string>
  readonly fetch?: typeof fetch
}

// Phantom-branded re-export of the underlying provider. The brand exists only
// at the type level (added via `as QvacProvider` in `createQvac`) so callers
// can distinguish a QVAC provider from any other OpenAI-compatible one in
// TypeScript without paying runtime cost.
export type QvacProvider = OpenAICompatibleProvider & {
  readonly _brand: 'qvac'
}
