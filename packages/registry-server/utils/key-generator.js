'use strict'

const crypto = require('crypto')

// Fixed salt: deterministic test keys only; domain-separates this KDF from unrelated PBKDF2 uses.
const PASSPHRASE_PBKDF2_SALT = Buffer.from('qvac-registry-server/passphrase-kdf-v1', 'utf8')
const PASSPHRASE_PBKDF2_ITERATIONS = 310000

function deriveKeyMaterialFromPassphrase (passphrase, byteLength) {
  return crypto.pbkdf2Sync(
    passphrase,
    PASSPHRASE_PBKDF2_SALT,
    PASSPHRASE_PBKDF2_ITERATIONS,
    byteLength,
    'sha256'
  )
}

function generatePrimaryKey (passphrase) {
  if (passphrase) {
    return deriveKeyMaterialFromPassphrase(passphrase, 32)
  }

  return crypto.randomBytes(32)
}

/**
 * Generate an ed25519 keypair for Hyperswarm/Autobase writer identity.
 * Uses sodium-universal (same as hypercore-crypto).
 *
 * @param {string} [passphrase] - Optional passphrase for deterministic generation (testing only)
 * @returns {{ publicKey: Buffer, secretKey: Buffer }} - 32-byte public key, 64-byte secret key
 */
function generateWriterKeyPair (passphrase) {
  // Defer require to avoid loading sodium unless needed
  const sodium = require('sodium-universal')

  const publicKey = Buffer.alloc(sodium.crypto_sign_PUBLICKEYBYTES)
  const secretKey = Buffer.alloc(sodium.crypto_sign_SECRETKEYBYTES)

  if (passphrase) {
    const seed = deriveKeyMaterialFromPassphrase(passphrase, 32)
    sodium.crypto_sign_seed_keypair(publicKey, secretKey, seed)
  } else {
    // Random keypair
    sodium.crypto_sign_keypair(publicKey, secretKey)
  }

  return { publicKey, secretKey }
}

module.exports = { generatePrimaryKey, generateWriterKeyPair }
