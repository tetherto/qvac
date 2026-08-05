import test from 'brittle'
import {
  configArgvForHarness,
  harnessConfigFromArgv,
  harnessLogLevel,
  resolveHarnessConfig
} from '../lib/config.ts'

test('harness config resolves explicit logging over environment', (t) => {
  const snapshot = resolveHarnessConfig(
    { level: 'debug' },
    { QVAC_LOG_LEVEL: 'error' }
  )

  t.is(harnessLogLevel(snapshot), 'debug')
})

test('harness config argv carries one generic immutable snapshot', (t) => {
  const snapshot = resolveHarnessConfig(
    undefined,
    { EXPO_PUBLIC_QVAC_LOG_LEVEL: 'warn' }
  )
  const argv = configArgvForHarness(snapshot)

  t.is(argv.length, 1)
  t.is(argv[0]?.startsWith('--harness-config='), true)
  t.alike(harnessConfigFromArgv(argv), snapshot)
})
