import { QvacErrorRAG, ERR_CODES } from '../errors.js'

interface HashLike {
  update(data: string | Uint8Array): HashLike
  digest(encoding?: string): string | Uint8Array
}

// The subset of a Node-style crypto module this package uses. On Bare/Node the
// `#crypto` import resolves to `bare-crypto`/`node:crypto`; elsewhere it falls
// back to this shim over `globalThis.crypto`.
export interface QvacCrypto {
  createHash(algorithm: string): HashLike
  randomBytes?(size: number): Uint8Array
  getRandomValues?<T extends ArrayBufferView>(array: T): T
}

function ensureCrypto(): QvacCrypto {
  const crypto = (globalThis as { crypto?: unknown }).crypto
  if (
    crypto &&
    crypto !== cryptoShim &&
    typeof (crypto as { createHash?: unknown }).createHash === 'function'
  ) {
    return crypto as QvacCrypto
  }
  throw new QvacErrorRAG({
    code: ERR_CODES.DEPENDENCY_REQUIRED,
    adds: 'No Node-style crypto implementation available. This code path requires globalThis.crypto.createHash, including HyperDB document hashing. Bare: install bare-crypto. Node: node:crypto is used by the package import map. Browser/RN: install and configure crypto-browserify, or another createHash-compatible polyfill, before using APIs that depend on #crypto.'
  })
}

const cryptoShim: QvacCrypto = new Proxy({} as QvacCrypto, {
  get(_target, prop) {
    return ensureCrypto()[prop as keyof QvacCrypto]
  },
  has(_target, prop) {
    try {
      return prop in ensureCrypto()
    } catch {
      return false
    }
  }
})

export default cryptoShim
