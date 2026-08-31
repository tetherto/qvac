import test from 'brittle'
import {
  DEFAULT_RPC_INIT_TIMEOUT_MS,
  RPC_INIT_TIMEOUT_ENV_VAR,
  resolveRPCInitTimeoutMs
} from '@/client/rpc/init-timeout'

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
test('RPC init timeout skips a malformed environment override and reports it', (t) => {
  const rejected: string[] = []
  const onInvalid = (source: string, value: string) => rejected.push(`${source}=${value}`)

  for (const envValue of ['abc', '0', '-5', '1.5', 'Infinity']) {
    t.is(resolveRPCInitTimeoutMs({ envValue, configValue: 120_000, onInvalid }), 120_000)
  }

  t.alike(rejected, [
    `${RPC_INIT_TIMEOUT_ENV_VAR}=abc`,
    `${RPC_INIT_TIMEOUT_ENV_VAR}=0`,
    `${RPC_INIT_TIMEOUT_ENV_VAR}=-5`,
    `${RPC_INIT_TIMEOUT_ENV_VAR}=1.5`,
    `${RPC_INIT_TIMEOUT_ENV_VAR}=Infinity`
  ])
})

test('RPC init timeout skips a malformed config value and reports it', (t) => {
  const rejected: string[] = []
  const onInvalid = (source: string, value: string) => rejected.push(`${source}=${value}`)

  t.is(
    resolveRPCInitTimeoutMs({ configValue: 0, onInvalid }),
    DEFAULT_RPC_INIT_TIMEOUT_MS,
    'a zero timeout would abort every start immediately'
  )
  t.alike(rejected, ['rpcInitTimeoutMs=0'])
})
