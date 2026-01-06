'use strict'

// Registry constants
const QVAC_MAIN_REGISTRY = 'qvac-main-registry'

// Autobase namespace
const AUTOBASE_NAMESPACE = 'registry'

// Legacy hypercore names (deprecated)
const HYPERCORE_NAMES = {
  REGISTRY: 'qvac-registry'
}

// Environment variable keys
const ENV_KEYS = {
  // Seed for registry corestore
  QVAC_REGISTRY_SEED: 'QVAC_REGISTRY_SEED',
  // Seed for model hyperdrives corestore
  QVAC_REGISTRY_DATA_SEED: 'QVAC_REGISTRY_DATA_SEED',
  // Primary key for registry corestore
  QVAC_PRIMARY_KEY: 'QVAC_PRIMARY_KEY',
  // Primary key for writer corestore (separate from registry)
  QVAC_WRITER_PRIMARY_KEY: 'QVAC_WRITER_PRIMARY_KEY',
  // Primary key for model hyperdrives corestore
  QVAC_MODEL_PRIMARY_KEY: 'QVAC_MODEL_PRIMARY_KEY',

  // Storage path for registry corestore
  REGISTRY_STORAGE: 'REGISTRY_STORAGE',
  // Storage path for model hyperdrives corestore
  MODEL_DRIVES_STORAGE: 'MODEL_DRIVES_STORAGE',

  // Registry discovery key
  QVAC_REGISTRY_DISCOVERY_KEY: 'QVAC_REGISTRY_DISCOVERY_KEY',
  // Registry core key
  QVAC_REGISTRY_CORE_KEY: 'QVAC_REGISTRY_CORE_KEY',
  // Autobase key
  QVAC_AUTOBASE_KEY: 'QVAC_AUTOBASE_KEY',
  // Allowlisted writer public keys (comma-separated)
  QVAC_ALLOWED_WRITER_KEYS: 'QVAC_ALLOWED_WRITER_KEYS',
  // Blind peer mirrors (comma-separated public keys)
  QVAC_BLIND_PEER_KEYS: 'QVAC_BLIND_PEER_KEYS',
  // Writer keypair for add-model RPC (CI/CD)
  QVAC_WRITER_PUBLIC_KEY: 'QVAC_WRITER_PUBLIC_KEY',
  QVAC_WRITER_SECRET_KEY: 'QVAC_WRITER_SECRET_KEY',
  // Additional indexer writer local keys (comma-separated z-base-32 keys)
  QVAC_ADDITIONAL_INDEXERS: 'QVAC_ADDITIONAL_INDEXERS',

  // AWS S3 credentials
  AWS_ACCESS_KEY_ID: 'AWS_ACCESS_KEY_ID',
  AWS_SECRET_ACCESS_KEY: 'AWS_SECRET_ACCESS_KEY',
  AWS_REGION: 'AWS_REGION',

  // HuggingFace token
  HUGGINGFACE_TOKEN: 'HUGGINGFACE_TOKEN'
}

// Default storage paths
const DEFAULT_PATHS = {
  REGISTRY_STORAGE: './corestore',
  MODEL_DRIVES_STORAGE: './model-drives',
  CLIENT_STORAGE: './storage'
}

module.exports = {
  QVAC_MAIN_REGISTRY,
  AUTOBASE_NAMESPACE,
  HYPERCORE_NAMES,
  ENV_KEYS,
  DEFAULT_PATHS
}
