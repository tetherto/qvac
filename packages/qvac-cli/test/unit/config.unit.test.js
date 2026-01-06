'use strict'

const test = require('brittle')
const os = require('os')
const path = require('path')
const { parseEnvVars } = require('../../src/utils/config')

test('parseEnvVars returns singleton instance', (t) => {
  const config1 = parseEnvVars()
  const config2 = parseEnvVars()

  t.is(config1, config2, 'should return the same instance')
})

test('parseEnvVars has correct default values', (t) => {
  // Clear any existing instance
  delete require.cache[require.resolve('../../src/utils/config')]
  const { parseEnvVars } = require('../../src/utils/config')

  const config = parseEnvVars()

  t.ok(config.logLevel, 'logLevel should be defined')
  t.ok(config.storageDir, 'storageDir should be defined')
  t.ok(config.qvacCoreStoreDir, 'qvacCoreStoreDir should be defined')
  t.ok(config.qvacHyperbeeKey, 'qvacHyperbeeKey should be defined')

  t.is(config.logLevel, 'info', 'default logLevel should be info')
  t.is(config.storageDir, path.join(os.homedir(), '.qvac/storage'), 'storageDir should default to ~/.qvac/storage')
  t.is(config.qvacCoreStoreDir, path.join(path.join(os.homedir(), '.qvac/storage'), 'corestore'), 'qvacCoreStoreDir should default correctly')
  t.is(config.qvacHyperbeeKey, '8919220166add186b84c882b5f4a2c56357e02f459a20b423a3ea7826ec70781', 'qvacHyperbeeKey should have correct default')
})
