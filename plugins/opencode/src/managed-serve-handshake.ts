import { randomBytes } from 'node:crypto'
import { writeSync } from 'node:fs'

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

export function createManagedProviderConfig(listening: HostListening, timeout: number) {
  return {
    npm: '@ai-sdk/openai-compatible',
    name: 'QVAC (local, managed)',
    options: { baseURL: listening.baseURL, apiKey: listening.proxyToken, timeout },
    models: {
      [listening.modelId]: {
        name: `${listening.modelName} (local)`,
        tool_call: true,
        reasoning: true
      }
    }
  }
}
