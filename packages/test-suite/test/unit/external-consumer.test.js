import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { externalRunEnv, runExternalPrepare } from '../../dist/cli/utils/external-consumer.js'

const entry = (extra = {}) => ({
  name: 'device',
  platform: 'kotlin-android',
  mode: 'mqtt',
  interpreter: process.execPath,
  args: [],
  cwd: '.',
  ...extra
})

test('an mqtt client is told the run, the platform and the broker', () => {
  const env = externalRunEnv(entry(), 'run-1', {
    brokerUrl: 'ws://127.0.0.1:8080',
    username: 'ci',
    password: 'secret',
    sessionExpiryInterval: 7200
  })
  assert.deepEqual(env, {
    QVAC_RUN_ID: 'run-1',
    QVAC_TEST_PLATFORM: 'kotlin-android',
    QVAC_MQTT_BROKER_URL: 'ws://127.0.0.1:8080',
    QVAC_MQTT_USERNAME: 'ci',
    QVAC_MQTT_PASSWORD: 'secret',
    QVAC_MQTT_SESSION_EXPIRY: '7200'
  })
})

test('unset credentials and expiry are left out rather than passed empty', () => {
  const env = externalRunEnv(entry(), 'run-1', { brokerUrl: 'ws://127.0.0.1:8080' })
  assert.deepEqual(Object.keys(env).sort(), [
    'QVAC_MQTT_BROKER_URL',
    'QVAC_RUN_ID',
    'QVAC_TEST_PLATFORM'
  ])
})

test('prepare runs in its cwd with the run in its environment', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qvac-prepare-'))
  const script = 'require("fs").writeFileSync("seen.json", JSON.stringify(process.env))'
  runExternalPrepare(
    dir,
    entry({ prepare: { interpreter: process.execPath, args: ['-e', script], cwd: '.' } }),
    { QVAC_RUN_ID: 'run-1' }
  )
  assert.equal(JSON.parse(readFileSync(join(dir, 'seen.json'), 'utf8')).QVAC_RUN_ID, 'run-1')
})

test('a failing prepare step throws with its exit code', () => {
  assert.throws(
    () =>
      runExternalPrepare(
        tmpdir(),
        entry({ prepare: { interpreter: process.execPath, args: ['-e', 'process.exit(3)'] } }),
        {}
      ),
    /prepare step for "device" exited with code 3/
  )
})

test('an entry without prepare is a no-op', () => {
  assert.doesNotThrow(() => runExternalPrepare(tmpdir(), entry(), {}))
})
