'use strict'

const path = require('path')
const process = require('process')
const IdEnc = require('hypercore-id-encoding')
const { ENV_KEYS } = require('@tetherto/qvac-registry-schema-mono')
const { getEnv, updateEnvFile } = require('../utils/env')

const AUTOBASE_ENV_KEY = ENV_KEYS.QVAC_AUTOBASE_KEY || 'QVAC_AUTOBASE_KEY'
const REGISTRY_CORE_KEY = ENV_KEYS.QVAC_REGISTRY_CORE_KEY || 'QVAC_REGISTRY_CORE_KEY'

/**
 * Centralized configuration for QVAC Registry
 * Handles all environment variables and default paths
 */
class RegistryConfig {
  constructor (opts = {}) {
    this.logger = opts.logger || console
  }

  /**
   * Get storage path for registry
   * Priority: provided value > env var > default
   */
  getRegistryStorage (providedPath) {
    if (providedPath) {
      return providedPath
    }

    const envPath = getEnv(ENV_KEYS.REGISTRY_STORAGE)
    const legacyPath = getEnv('QVAC_REGISTRY_CORE_PATH')
    const defaultPath = path.resolve(process.cwd(), './corestore')
    const result = envPath || legacyPath || defaultPath
    return result
  }

  /**
   * Get storage path for model drives
   */
  getModelDrivesStorage (providedPath) {
    if (providedPath) {
      return providedPath
    }

    const envPath = getEnv(ENV_KEYS.MODEL_DRIVES_STORAGE)
    const defaultPath = path.resolve(process.cwd(), './model-drives')
    const result = envPath || defaultPath
    return result
  }

  /**
   * Get storage path for temporary files during model ingestion
   * Located at same level as model-drives storage
   */
  getTempStorage (providedPath) {
    if (providedPath) {
      return providedPath
    }

    const envPath = getEnv('TEMP_STORAGE')
    if (envPath) {
      return envPath
    }

    const modelStorage = this.getModelDrivesStorage()
    return path.join(path.dirname(modelStorage), 'temp')
  }

  /**
   * Get primary key for deterministic key derivation (testing/development only)
   * Priority: provided value > env var > null
   * Returns Buffer(32) or null
   */
  getPrimaryKey (providedKey) {
    if (providedKey) {
      try {
        return IdEnc.decode(providedKey)
      } catch (err) {
        this.logger.warn({ err, key: providedKey }, 'Invalid primary key format, expected hex or z-base-32')
        return null
      }
    }

    const envKey = getEnv(ENV_KEYS.QVAC_PRIMARY_KEY)
    if (!envKey) return null

    try {
      return IdEnc.decode(envKey)
    } catch (err) {
      this.logger.warn({ err, key: envKey }, 'Invalid QVAC_PRIMARY_KEY format, expected hex or z-base-32')
      return null
    }
  }

  /**
   * Get writer primary key for deterministic writer keypair derivation (testing/development only)
   * Priority: provided value > env var > null
   * Returns Buffer(32) or null
   */
  getWriterPrimaryKey (providedKey) {
    if (providedKey) {
      try {
        return IdEnc.decode(providedKey)
      } catch (err) {
        this.logger.warn({ err, key: providedKey }, 'Invalid writer primary key format, expected hex or z-base-32')
        return null
      }
    }

    const envKey = getEnv(ENV_KEYS.QVAC_WRITER_PRIMARY_KEY)
    if (!envKey) return null

    try {
      return IdEnc.decode(envKey)
    } catch (err) {
      this.logger.warn({ err, key: envKey }, 'Invalid QVAC_WRITER_PRIMARY_KEY format, expected hex or z-base-32')
      return null
    }
  }

  /**
   * Get Autobase bootstrap key used to join an existing writer set
   */
  getAutobaseBootstrapKey (providedKey) {
    if (providedKey) {
      return providedKey
    }

    const envKey = getEnv(AUTOBASE_ENV_KEY)
    return envKey || null
  }

  /**
   * Persist Autobase key for future restarts
   */
  setAutobaseKey (key) {
    if (!key) return
    updateEnvFile(AUTOBASE_ENV_KEY, key)
  }

  /**
   * Set registry core key in environment
   */
  setRegistryCoreKey (key) {
    if (!key) return
    updateEnvFile(REGISTRY_CORE_KEY, key)
  }

  /**
   * Get spec path for HyperDB schemas
   */
  getSpecPath () {
    const specPath = path.join(__dirname, '..', 'spec')
    return specPath
  }

  /**
   * Get all AWS credentials
   */
  getAWSCredentials () {
    const creds = {
      accessKeyId: getEnv(ENV_KEYS.AWS_ACCESS_KEY_ID),
      secretAccessKey: getEnv(ENV_KEYS.AWS_SECRET_ACCESS_KEY),
      region: getEnv(ENV_KEYS.AWS_REGION, 'eu-central-1')
    }
    return creds
  }

  /**
   * Get HuggingFace token
   */
  getHuggingFaceToken () {
    const token = getEnv(ENV_KEYS.HUGGINGFACE_TOKEN)
    return token
  }

  /**
   * Get registry core key for RPC client connections
   */
  getRegistryCoreKey () {
    const key = getEnv(ENV_KEYS.QVAC_REGISTRY_CORE_KEY)
    return key || null
  }

  /**
   * Parse allowlisted writer keys from environment
   */
  getAllowedWriterKeys () {
    const rawKeys = getEnv(ENV_KEYS.QVAC_ALLOWED_WRITER_KEYS, '')
    if (!rawKeys) return new Set()

    const normalized = rawKeys
      .split(',')
      .map(key => key.trim().toLowerCase())
      .filter(Boolean)

    return new Set(normalized)
  }

  /**
   * Append a writer key to the allowlist and persist it
   */
  addAllowedWriterKey (key) {
    if (!key || typeof key !== 'string') return

    const normalizedKey = key.trim().toLowerCase()
    if (!normalizedKey) return

    const keys = this.getAllowedWriterKeys()
    if (keys.has(normalizedKey)) return normalizedKey

    keys.add(normalizedKey)
    const serialized = Array.from(keys).join(',')
    updateEnvFile(ENV_KEYS.QVAC_ALLOWED_WRITER_KEYS, serialized)
    return normalizedKey
  }

  /**
   * Get configured blind peer mirrors (comma-separated keys)
   */
  getBlindPeerKeys () {
    const rawKeys = getEnv(ENV_KEYS.QVAC_BLIND_PEER_KEYS, '')
    if (!rawKeys) return []

    return rawKeys
      .split(',')
      .map(key => key.trim())
      .filter(Boolean)
  }

  getAdditionalIndexers () {
    const rawKeys = getEnv(ENV_KEYS.QVAC_ADDITIONAL_INDEXERS, '')
    if (!rawKeys) return []

    return rawKeys
      .split(',')
      .map(key => key.trim())
      .filter(Boolean)
  }

  /**
   * Optionally load writer keypair from env (CI use-case)
   */
  getWriterKeyPair () {
    const publicKeyHex = getEnv(ENV_KEYS.QVAC_WRITER_PUBLIC_KEY)
    const secretKeyHex = getEnv(ENV_KEYS.QVAC_WRITER_SECRET_KEY)

    if (!publicKeyHex || !secretKeyHex) return null

    return {
      publicKey: Buffer.from(publicKeyHex, 'hex'),
      secretKey: Buffer.from(secretKeyHex, 'hex')
    }
  }
}

module.exports = RegistryConfig
