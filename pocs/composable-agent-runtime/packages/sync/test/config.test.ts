import test from 'brittle'
import {
  configForSyncRuntime,
  decodeSyncConfig,
  encodeSyncConfig,
  resolveSyncConfig,
  syncLogLevel
} from '../lib/config.ts'

test('sync config resolves explicit logging over environment', (t) => {
  const snapshot = resolveSyncConfig(
    { level: 'debug' },
    { QVAC_LOG_LEVEL: 'error' }
  )

  t.is(syncLogLevel(snapshot), 'debug')
})

test('sync config resolves environment aliases for standalone use', (t) => {
  const snapshot = resolveSyncConfig(
    undefined,
    { EXPO_PUBLIC_QVAC_LOG_LEVEL: 'warn' }
  )

  t.is(syncLogLevel(snapshot), 'warn')
})

test('sync runtime config has a deterministic transport envelope', (t) => {
  const snapshot = configForSyncRuntime(
    { level: 'off' },
    { QVAC_LOG_LEVEL: 'error' }
  )

  t.alike(decodeSyncConfig(encodeSyncConfig(snapshot)), snapshot)
  t.is(syncLogLevel(snapshot), 'off')
})
