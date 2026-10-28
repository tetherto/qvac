// bare-crypto stand-in for the browser build. WebCrypto's digest is one-shot
// and asynchronous, so streaming SHA-256 comes from @noble/hashes.
import { sha256 } from '@noble/hashes/sha2.js'
import Buffer from './buffer'
import { browser } from './globals'

const ALGORITHMS = new Set(['sha256', 'sha-256'])

class Hash {
  private readonly state = sha256.create()

  update(data: Uint8Array | string): this {
    this.state.update(typeof data === 'string' ? Buffer.from(data) : data)
    return this
  }

  digest(encoding?: 'hex' | 'base64'): Buffer | string {
    const bytes = Buffer.from(this.state.digest())
    return encoding ? bytes.toString(encoding) : bytes
  }
}

export function createHash(algorithm: string): Hash {
  if (!ALGORITHMS.has(algorithm.toLowerCase())) {
    throw new Error(`Hash algorithm ${algorithm} is not available in the browser`)
  }
  return new Hash()
}

export function randomUUID(): string {
  return browser.crypto.randomUUID()
}

export default { createHash, randomUUID }
