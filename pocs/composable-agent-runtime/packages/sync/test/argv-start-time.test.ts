import test from 'brittle'
import { createSyncMobileEntry } from '../mobile-entry.ts'
import {
  WORKLET_ARGV_LAYOUT,
  createSyncWorkletArgv,
  parseSyncWorkletArgv
} from '../lib/react-native-argv.ts'
import { encodeSyncConfig, resolveSyncConfig } from '../lib/config.ts'

const config = resolveSyncConfig(undefined, {})
const encodedConfig = encodeSyncConfig(config)

test('sync mobile entry resolves argv at start time', async (t) => {
  let argv = [
    'bare',
    'sync.bundle',
    JSON.stringify({ storagePath: '/tmp/start-a', config: encodedConfig })
  ]
  const storages: string[] = []
  const entry = createSyncMobileEntry({
    readArgv() {
      return argv
    },
    markerExists: async () => true,
    createCore(options) {
      storages.push(options.storagePath)
      return {
        writable: true,
        async ready() {},
        connect() {},
        async close() {}
      }
    },
    createStream() {
      return {
        once() {},
        on() {},
        write() {
          return true
        },
        destroy() {}
      } as never
    },
    ensureStorage: async () => {},
    writeMarker: async () => {}
  })

  await entry({} as never)
  argv = [
    'bare',
    'sync.bundle',
    JSON.stringify({ storagePath: '/tmp/start-b', config: encodedConfig })
  ]
  await entry({} as never)

  t.alike(storages, ['/tmp/start-a', '/tmp/start-b'])
})

test('sync worklet argv layout round-trips launcher to entry parser', async (t) => {
  const argv = createSyncWorkletArgv({
    storagePath: '/tmp/roundtrip',
    pairingInvite: Buffer.from('fbff0001', 'hex'),
    config
  })
  t.is(argv[WORKLET_ARGV_LAYOUT.runtime], 'react-native-bare-kit')
  t.is(argv[WORKLET_ARGV_LAYOUT.entry], 'sync.js')
  const parsed = parseSyncWorkletArgv(argv)
  t.alike(parsed, {
    storagePath: '/tmp/roundtrip',
    bootstrap: undefined,
    meshSeed: undefined,
    meshKey: undefined,
    pairingInvite: Buffer.from('fbff0001', 'hex'),
    config: encodedConfig
  })
})
