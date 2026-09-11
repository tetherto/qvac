'use strict'

const test = require('brittle')

const RegistryConfig = require('../../lib/config')

const ENV_KEY = 'QVAC_BLOB_CORE_GENERATION'

test('RegistryConfig defaults blob core generation to legacy core', (t) => {
  withEnv(t, ENV_KEY, undefined)

  const config = new RegistryConfig()

  t.is(config.getBlobCoreGeneration(), null)
  t.is(config.getBlobCoreGeneration(''), null)
  t.is(config.getBlobCoreGeneration('   '), null)
})

test('RegistryConfig reads and trims blob core generation', (t) => {
  withEnv(t, ENV_KEY, '  2026-09-10  ')

  const config = new RegistryConfig()

  t.is(config.getBlobCoreGeneration(), '2026-09-10')
})

test('RegistryConfig explicit blob core generation overrides environment', (t) => {
  withEnv(t, ENV_KEY, 'environment-generation')

  const config = new RegistryConfig()

  t.is(config.getBlobCoreGeneration('provided-generation'), 'provided-generation')
})

test('RegistryConfig rejects invalid blob core generations', async (t) => {
  withEnv(t, ENV_KEY, undefined)

  const config = new RegistryConfig()

  await t.exception.all(
    () => config.getBlobCoreGeneration('2026/09/10'),
    /QVAC_BLOB_CORE_GENERATION must contain only/
  )
  await t.exception.all(
    () => config.getBlobCoreGeneration(2),
    /QVAC_BLOB_CORE_GENERATION must be a string/
  )
})

function withEnv(t, key, value) {
  const previous = process.env[key]

  if (value === undefined) delete process.env[key]
  else process.env[key] = value

  t.teardown(() => {
    if (previous === undefined) delete process.env[key]
    else process.env[key] = previous
  })
}
