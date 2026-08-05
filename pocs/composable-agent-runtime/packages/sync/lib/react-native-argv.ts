export const WORKLET_ARGV_LAYOUT = {
  runtime: 0,
  entry: 1,
  optionsJson: 2
} as const

import type { CreateSyncOptions } from './runtime/types.ts'
import type { ConfigSnapshot } from '@qvac/config'
import { encodeSyncConfig } from './config.ts'

export interface SyncWorkletOptions
  extends Omit<CreateSyncOptions, 'logging'> {
  readonly config: ConfigSnapshot
}

interface EncodedSyncWorkletOptions {
  readonly storagePath: string
  readonly bootstrap?: CreateSyncOptions['bootstrap']
  readonly meshSeed?: string
  readonly meshKey?: string
  readonly pairingInvite?: string
  readonly config: string
}

export function createSyncWorkletArgv(options: SyncWorkletOptions) {
  return [
    'react-native-bare-kit',
    'sync.js',
    JSON.stringify({
      storagePath: options.storagePath,
      bootstrap: options.bootstrap,
      meshSeed: options.meshSeed?.toString('hex'),
      meshKey: options.meshKey?.toString('hex'),
      pairingInvite: options.pairingInvite?.toString('hex'),
      config: encodeSyncConfig(options.config)
    } satisfies EncodedSyncWorkletOptions)
  ]
}

export function parseSyncWorkletArgv(
  argv: readonly string[]
): Omit<CreateSyncOptions, 'logging'> & {
  readonly storagePath: string
  readonly config: string
} {
  const encoded = argv[WORKLET_ARGV_LAYOUT.optionsJson]
  if (!encoded) throw new Error('Mobile Sync Worklet options are required')
  const parsed: unknown = JSON.parse(encoded)
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('storagePath' in parsed) ||
    typeof parsed.storagePath !== 'string' ||
    parsed.storagePath.length === 0
  ) {
    throw new Error('Mobile Sync Worklet storagePath is required')
  }
  assertOptionalString(parsed, 'meshSeed')
  assertOptionalString(parsed, 'meshKey')
  assertOptionalString(parsed, 'pairingInvite')
  const bootstrap = Reflect.get(parsed, 'bootstrap')
  if (bootstrap !== undefined && !isBootstrap(bootstrap)) {
    throw new Error('Mobile Sync Worklet bootstrap nodes are invalid')
  }
  assertOptionalString(parsed, 'config')
  const config = Reflect.get(parsed, 'config')
  if (typeof config !== 'string' || config.length === 0) {
    throw new Error('Mobile Sync Worklet configuration is required')
  }
  return {
    storagePath: parsed.storagePath,
    bootstrap,
    meshSeed: decodeBuffer(parsed, 'meshSeed'),
    meshKey: decodeBuffer(parsed, 'meshKey'),
    pairingInvite: decodeBuffer(parsed, 'pairingInvite'),
    config
  }
}

function isBootstrap(value: unknown): value is CreateSyncOptions['bootstrap'] {
  return (
    Array.isArray(value) &&
    value.every(
      (node) =>
        typeof node === 'object' &&
        node !== null &&
        typeof Reflect.get(node, 'host') === 'string' &&
        Number.isSafeInteger(Reflect.get(node, 'port'))
    )
  )
}

function assertOptionalString(value: object, key: string) {
  const field = Reflect.get(value, key)
  if (field !== undefined && typeof field !== 'string') {
    throw new Error(`Mobile Sync Worklet ${key} must be a string`)
  }
}

function decodeBuffer(value: object, key: string) {
  const field = Reflect.get(value, key)
  return typeof field === 'string' ? Buffer.from(field, 'hex') : undefined
}
