import test from 'brittle'
import { readFile } from 'node:fs/promises'
import * as sync from '../index.ts'

test('sync: main entry exposes only the stable runtime surface', (t) => {
  const exports = Object.keys(sync).sort()
  t.alike(exports, [
    'SYNC_HANDSHAKE',
    'SyncGenerationEndedError',
    'SyncSuspendedError',
    'assertCompatibleRuntime',
    'createSync',
    'syncCompatibility'
  ])
})

test('sync: package exports hide implementation and select the mobile runtime', async (t) => {
  const manifest = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8')
  )
  t.alike(manifest.exports['.'], {
    'react-native': './react-native.ts',
    default: './index.ts'
  })
  t.is(manifest.exports['./react-native'], './react-native.ts')
  t.is(manifest.exports['./testing'], './testing.ts')
  t.is(manifest.exports['./worker'], './worker.ts')
  t.is(manifest.exports['./types'], './lib/runtime/types.ts')
  t.absent(manifest.exports['./sidecar-entry'])
  t.absent(manifest.exports['./mobile-entry'])
  t.absent(manifest.exports['./react-native-launcher'])
  t.absent(manifest.exports['./react-native-stow'])
  t.absent(manifest.exports['./core'])
  t.absent(manifest.exports['./client'])
  t.absent(manifest.exports['./spawn'])
})

test('sync: React Native entry mirrors the stable value exports', async (t) => {
  const mobile = await import('../react-native.ts')
  t.alike(Object.keys(mobile).sort(), [
    'SYNC_HANDSHAKE',
    'SyncGenerationEndedError',
    'SyncSuspendedError',
    'assertCompatibleRuntime',
    'createSync',
    'syncCompatibility'
  ])
})
