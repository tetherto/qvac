import test from 'brittle'
import { DEFAULT_RPC_INIT_TIMEOUT_MS, resolveRPCInitTimeoutMs } from '@/client/rpc/init-timeout'

test('RPC init timeout falls back to the default when nothing overrides it', (t) => {
  t.is(resolveRPCInitTimeoutMs(), DEFAULT_RPC_INIT_TIMEOUT_MS)
  t.is(resolveRPCInitTimeoutMs({ envValue: undefined, configValue: undefined }), 30_000)
})

test('RPC init timeout reads rpcInitTimeoutMs from config', (t) => {
  t.is(resolveRPCInitTimeoutMs({ configValue: 120_000 }), 120_000)
})

test('RPC init timeout prefers the environment over config', (t) => {
  t.is(resolveRPCInitTimeoutMs({ envValue: '90000', configValue: 120_000 }), 90_000)
})

test('RPC init timeout ignores an unset or blank environment variable', (t) => {
  t.is(resolveRPCInitTimeoutMs({ envValue: '', configValue: 120_000 }), 120_000)
  t.is(resolveRPCInitTimeoutMs({ envValue: '   ', configValue: 120_000 }), 120_000)
})

// A mistyped tuning value must not turn into a hard initialization failure.
// Only the environment needs this: a bad `rpcInitTimeoutMs` is rejected earlier
// by config validation and never reaches the resolver.
test('RPC init timeout skips a malformed environment override and reports it', (t) => {
  const rejected: string[] = []
  const onInvalidEnvValue = (value: string) => rejected.push(value)

  for (const envValue of ['abc', '0', '-5', '1.5', 'Infinity']) {
    t.is(
      resolveRPCInitTimeoutMs({ envValue, configValue: 120_000, onInvalidEnvValue }),
      120_000,
      `${envValue} falls through to the config value`
    )
  }

  t.alike(rejected, ['abc', '0', '-5', '1.5', 'Infinity'])
})

test('RPC init timeout falls back to the default when only the environment is set and bad', (t) => {
  t.is(resolveRPCInitTimeoutMs({ envValue: 'abc' }), DEFAULT_RPC_INIT_TIMEOUT_MS)
})
