import test from 'brittle'
import {
  CONFIG_SNAPSHOT_VERSION,
  createConfigStore,
  defineConfigKey,
  deserializeConfig,
  getConfigSnapshot,
  getConfigValue,
  getOptionalConfigSnapshot,
  installConfig,
  resolveConfig,
  serializeConfig,
  type ConfigValue
} from '../index.ts'

const levelKey = defineConfigKey({
  name: 'logging.level',
  env: ['APP_LOG_LEVEL', 'PUBLIC_APP_LOG_LEVEL'],
  default: 'info',
  parse(value) {
    if (
      value === 'error' ||
      value === 'warn' ||
      value === 'info' ||
      value === 'debug' ||
      value === 'off'
    ) {
      return value
    }
    throw new Error('logging.level must be a supported log level')
  }
})

const retriesKey = defineConfigKey({
  name: 'network.retries',
  env: ['APP_RETRIES'],
  parse(value) {
    const parsed =
      typeof value === 'string' && value.length > 0
        ? Number(value)
        : value
    if (
      typeof parsed !== 'number' ||
      !Number.isSafeInteger(parsed) ||
      parsed < 0
    ) {
      throw new Error('network.retries must be a non-negative integer')
    }
    return parsed
  }
})

test('explicit values override environment values and defaults', (t) => {
  const snapshot = resolveConfig({
    keys: [levelKey, retriesKey],
    values: {
      'logging.level': 'debug',
      'network.retries': 5
    },
    env: {
      APP_LOG_LEVEL: 'error',
      APP_RETRIES: '2'
    }
  })

  t.alike(snapshot, {
    version: CONFIG_SNAPSHOT_VERSION,
    values: {
      'logging.level': 'debug',
      'network.retries': 5
    }
  })
})

test('environment aliases use declaration order before defaults', (t) => {
  const snapshot = resolveConfig({
    keys: [levelKey],
    env: {
      APP_LOG_LEVEL: '',
      PUBLIC_APP_LOG_LEVEL: 'warn'
    }
  })
  const fallback = resolveConfig({ keys: [levelKey], env: {} })

  t.is(snapshot.values['logging.level'], 'warn')
  t.is(fallback.values['logging.level'], 'info')
})

test('invalid and unknown explicit values fail during resolution', async (t) => {
  await t.exception(
    Promise.resolve().then(() =>
      resolveConfig({
        keys: [levelKey],
        values: { 'logging.level': 'verbose' }
      })
    ),
    /logging\.level must be a supported log level/
  )
  await t.exception(
    Promise.resolve().then(() =>
      resolveConfig({
        keys: [levelKey],
        values: { 'logging.leevl': 'debug' }
      })
    ),
    /Unknown configuration key: logging\.leevl/
  )
})

test('snapshots are cloned and deeply frozen', (t) => {
  const input: Record<string, ConfigValue> = {
    'nested.object': {
      array: [{ enabled: true }]
    }
  }
  const snapshot = resolveConfig({
    keys: [
      defineConfigKey({
        name: 'nested.object',
        parse(value) {
          return value
        }
      })
    ],
    values: input
  })

  const nested = snapshot.values['nested.object']
  input['nested.object'] = null

  t.ok(Object.isFrozen(snapshot))
  t.ok(Object.isFrozen(snapshot.values))
  t.ok(typeof nested === 'object' && nested !== null && Object.isFrozen(nested))
  t.alike(nested, { array: [{ enabled: true }] })
})

test('serialization is deterministic for equivalent object key order', (t) => {
  const left = resolveConfig({
    keys: [
      defineConfigKey({
        name: 'object.value',
        parse(value) {
          return value
        }
      })
    ],
    values: { 'object.value': { z: 1, a: { y: true, b: false } } }
  })
  const right = resolveConfig({
    keys: [
      defineConfigKey({
        name: 'object.value',
        parse(value) {
          return value
        }
      })
    ],
    values: { 'object.value': { a: { b: false, y: true }, z: 1 } }
  })

  t.is(serializeConfig(left), serializeConfig(right))
})

test('serialization round trips a strict immutable snapshot', (t) => {
  const original = resolveConfig({
    keys: [levelKey, retriesKey],
    values: {
      'logging.level': 'off',
      'network.retries': 3
    }
  })
  const decoded = deserializeConfig(serializeConfig(original))

  t.alike(decoded, original)
  t.ok(Object.isFrozen(decoded))
  t.ok(Object.isFrozen(decoded.values))
})

test('decoding rejects malformed and unsupported envelopes', async (t) => {
  await t.exception(
    Promise.resolve().then(() => deserializeConfig('{')),
    /Invalid configuration snapshot JSON/
  )
  await t.exception(
    Promise.resolve().then(() =>
      deserializeConfig(JSON.stringify({ version: 2, values: {} }))
    ),
    /Unsupported configuration snapshot version: 2/
  )
  await t.exception(
    Promise.resolve().then(() =>
      deserializeConfig(JSON.stringify({ version: 1, values: { bad: null } }))
    ),
    /Configuration snapshot key must contain a namespace/
  )
})

test('stores reject reads before installation', async (t) => {
  const store = createConfigStore()

  t.is(getOptionalConfigSnapshot(), undefined)
  await t.exception(
    Promise.resolve().then(() => store.snapshot()),
    /Configuration is not installed/
  )
})

test('identical store installation is idempotent and conflicts fail', async (t) => {
  const store = createConfigStore()
  const first = resolveConfig({
    keys: [levelKey],
    values: { 'logging.level': 'debug' }
  })
  const same = deserializeConfig(serializeConfig(first))
  const conflict = resolveConfig({
    keys: [levelKey],
    values: { 'logging.level': 'error' }
  })

  store.install(first)
  store.install(same)
  t.is(store.get(levelKey), 'debug')
  await t.exception(
    Promise.resolve().then(() => store.install(conflict)),
    /Configuration is already installed with different values/
  )
})

test('independent stores do not share installed snapshots', (t) => {
  const first = createConfigStore()
  const second = createConfigStore()
  first.install(
    resolveConfig({
      keys: [levelKey],
      values: { 'logging.level': 'warn' }
    })
  )
  second.install(
    resolveConfig({
      keys: [levelKey],
      values: { 'logging.level': 'off' }
    })
  )

  t.is(first.get(levelKey), 'warn')
  t.is(second.get(levelKey), 'off')
})

test('default store exposes the installed process snapshot', (t) => {
  const snapshot = resolveConfig({
    keys: [levelKey],
    values: { 'logging.level': 'debug' }
  })

  installConfig(snapshot)
  installConfig(deserializeConfig(serializeConfig(snapshot)))

  t.is(getConfigValue(levelKey), 'debug')
  t.alike(getConfigSnapshot(), snapshot)
})
