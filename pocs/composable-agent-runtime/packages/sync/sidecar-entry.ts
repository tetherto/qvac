import process from 'bare-process'
import type { Duplex } from 'streamx'
import { SyncCore, type SyncCoreOptions } from './lib/core.ts'

interface EncodedSyncCoreOptions {
  readonly storagePath: string
  readonly bootstrap?: SyncCoreOptions['bootstrap']
  readonly meshSeed?: string
  readonly meshKey?: string
  readonly pairingInvite?: string
  readonly logging?: SyncCoreOptions['logging']
}

const OPTIONS_PREFIX = '--sync-options='

export default async function start(stream: Duplex) {
  const core = new SyncCore(decodeOptions(process.argv))
  await core.ready()
  core.connect(stream)
  return async function stop() {
    await core.close()
  }
}

function decodeOptions(argv: readonly string[]): SyncCoreOptions {
  const argument = argv.find((value) => value.startsWith(OPTIONS_PREFIX))
  if (!argument) throw new Error('Missing spawned Sync options')
  const encoded = argument.slice(OPTIONS_PREFIX.length)
  const options: EncodedSyncCoreOptions = JSON.parse(encoded)
  if (!options.storagePath) throw new Error('Spawned Sync storagePath is required')
  return {
    storagePath: options.storagePath,
    runtimeProcessId: process.pid,
    bootstrap: options.bootstrap,
    logging: options.logging,
    meshSeed: options.meshSeed ? Buffer.from(options.meshSeed, 'hex') : undefined,
    meshKey: options.meshKey ? Buffer.from(options.meshKey, 'hex') : undefined,
    pairingInvite: options.pairingInvite
      ? Buffer.from(options.pairingInvite, 'hex')
      : undefined
  }
}
