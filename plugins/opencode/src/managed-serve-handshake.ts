import { randomBytes } from 'node:crypto'
import { writeSync } from 'node:fs'

import type { Model, Provider } from '@opencode/plugin'

import { HostHandshakeChannelUnavailableError, HostInvalidHandshakeError } from './errors.js'

// The proxy token authenticates OpenCode against the host proxy. It is the only
// credential that ever leaves the host: the real managed serve key stays inside
// the host process and is attached to upstream requests there.
export interface HostListening {
  readonly proxyToken: string
  readonly baseURL: string
  readonly modelId: string
  readonly modelName: string
}

// A dedicated pipe keeps the handshake off stdout, which carries human-readable
// host logs that the plugin may mirror to OpenCode's stderr in debug mode.
export const HANDSHAKE_FD = 3
export const HANDSHAKE_PREFIX = 'QVAC_LISTENING '

const PROXY_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/

export function generateProxyToken(): string {
  return randomBytes(32).toString('base64url')
}

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
  if (typeof value['proxyToken'] !== 'string' || !PROXY_TOKEN_PATTERN.test(value['proxyToken'])) {
    throw new HostInvalidHandshakeError('proxyToken is missing or invalid')
  }
  if (
    typeof value['baseURL'] !== 'string' ||
    typeof value['modelId'] !== 'string' ||
    typeof value['modelName'] !== 'string'
  ) {
    throw new HostInvalidHandshakeError('provider metadata is missing or invalid')
  }

  return {
    proxyToken: value['proxyToken'],
    baseURL: value['baseURL'],
    modelId: value['modelId'],
    modelName: value['modelName']
  }
}

export function formatHostListening(listening: HostListening): string {
  return `${HANDSHAKE_PREFIX}${JSON.stringify(listening)}\n`
}

export function writeHostListening(listening: HostListening, fd = HANDSHAKE_FD): void {
  const line = Buffer.from(formatHostListening(listening), 'utf8')
  let written = 0
  while (written < line.length) {
    try {
      written += writeSync(fd, line, written)
    } catch (err) {
      // A short handshake never fills the pipe, but a non-blocking parent end
      // can still ask us to retry. Anything else (a missing channel) is fatal.
      if ((err as NodeJS.ErrnoException).code !== 'EAGAIN') {
        throw new HostHandshakeChannelUnavailableError(fd, err)
      }
    }
  }
}

// Plain data in the V2 provider/model shape. The host process imports this
// module too and has no `@opencode/plugin` at runtime, so only types come from it.
export const PROVIDER_ID = 'qvac'
export const PROVIDER_PACKAGE = '@opencode/ai/providers/openai-compatible'

export function createManagedProviderConfig(
  listening: HostListening,
  options: { readonly readyTimeoutMs: number; readonly ctxSize: number }
): { info: Provider.Info; models: Model.Info[] } {
  const providerID = PROVIDER_ID as Provider.ID
  const modelID = listening.modelId as Model.ID
  return {
    info: {
      id: providerID,
      name: 'QVAC (local, managed)',
      activation: 'enabled',
      package: PROVIDER_PACKAGE,
      settings: {
        baseURL: listening.baseURL,
        apiKey: listening.proxyToken,
        timeout: options.readyTimeoutMs
      }
    },
    models: [
      {
        id: modelID,
        modelID,
        providerID,
        name: `${listening.modelName} (local)`,
        capabilities: { tools: true, input: ['text'], output: ['text'] },
        variants: [],
        time: { released: 0 },
        cost: [],
        status: 'active',
        enabled: true,
        limit: { context: options.ctxSize, output: Math.min(32_000, options.ctxSize) }
      }
    ]
  }
}
