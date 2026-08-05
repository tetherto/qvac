import process from 'bare-process'
import type { Duplex } from 'streamx'
import { SyncCore, type SyncCoreOptions } from './lib/core.ts'
import { installSyncConfig } from './lib/config.ts'

interface EncodedSyncCoreOptions {
  readonly storagePath: string
  readonly bootstrap?: SyncCoreOptions['bootstrap']
  readonly meshSeed?: string
  readonly meshKey?: string
  readonly pairingInvite?: string
  readonly config: string
}

const OPTIONS_PREFIX = '--sync-options='

export default async function start(stream: Duplex) {
  const options = decodeOptions(process.argv)
  installSyncConfig(options.config)
  const core = new SyncCore(options.core)
  await core.ready()
  core.connect(stream)
  return async function stop() {
    await core.close()
  }
}

function decodeOptions(argv: readonly string[]) {
  const argument = argv.find((value) => value.startsWith(OPTIONS_PREFIX))
  if (!argument) throw new Error('Missing spawned Sync options')
  const encoded = argument.slice(OPTIONS_PREFIX.length)
  const options: EncodedSyncCoreOptions = JSON.parse(encoded)
  if (!options.storagePath) throw new Error('Spawned Sync storagePath is required')
  if (!options.config) throw new Error('Spawned Sync configuration is required')
  return {
    config: options.config,
    core: {
      storagePath: options.storagePath,
      runtimeProcessId: process.pid,
      bootstrap: options.bootstrap,
      meshSeed: options.meshSeed ? Buffer.from(options.meshSeed, 'hex') : undefined,
      meshKey: options.meshKey ? Buffer.from(options.meshKey, 'hex') : undefined,
      pairingInvite: options.pairingInvite
        ? Buffer.from(options.pairingInvite, 'hex')
        : undefined
    } satisfies SyncCoreOptions
  }
}
