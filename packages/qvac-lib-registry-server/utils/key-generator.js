'use strict'

const crypto = require('crypto')

function generatePrimaryKey (passphrase) {
  const hash = crypto.createHash('sha256')

  if (passphrase) {
    hash.update(passphrase)
    return hash.digest()
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
    // Deterministic: derive seed from passphrase
    const seed = crypto.createHash('sha256').update(passphrase).digest()
    sodium.crypto_sign_seed_keypair(publicKey, secretKey, seed)
  } else {
    // Random keypair
    sodium.crypto_sign_keypair(publicKey, secretKey)
  }

  return { publicKey, secretKey }
}

module.exports = { generatePrimaryKey, generateWriterKeyPair }
