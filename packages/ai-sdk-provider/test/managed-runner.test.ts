import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import test from 'node:test'

import {
  decideReap,
  readRunnerParamsFile,
  runnerSpawnSpec,
  writeRunnerParamsFile
} from '../src/managed/runner.js'
import type { RunnerParams } from '../src/managed/runner.js'
import { withFakeHome } from './helpers/fake-serve.js'

const RUNNER_PARAMS: RunnerParams = {
  fleetKey: 'fleet',
  apiKey: 'runner-secret-key',
  configPath: '/tmp/qvac.config.json',
  port: 1234,
  host: '127.0.0.1',
  idleTimeoutMs: 1000,
  startTimeoutMs: 1000
}

test('decideReap never reaps while a consumer is alive and resets the idle clock', () => {
  const r = decideReap({ liveConsumerCount: 2, emptySince: 1000, now: 5000, idleTimeoutMs: 1000 })
  assert.deepEqual(r, { emptySince: null, reap: false })
})

test('decideReap starts the idle clock when the consumer set first goes empty', () => {
  const r = decideReap({ liveConsumerCount: 0, emptySince: null, now: 5000, idleTimeoutMs: 1000 })
  assert.deepEqual(r, { emptySince: 5000, reap: false })
})

test('decideReap does not reap before the idle timeout elapses', () => {
  const r = decideReap({ liveConsumerCount: 0, emptySince: 5000, now: 5500, idleTimeoutMs: 1000 })
  assert.deepEqual(r, { emptySince: 5000, reap: false })
})

test('decideReap reaps once the idle timeout has elapsed with no consumers', () => {
  const r = decideReap({ liveConsumerCount: 0, emptySince: 5000, now: 6000, idleTimeoutMs: 1000 })
  assert.deepEqual(r, { emptySince: 5000, reap: true })
})

test('decideReap with a zero timeout (private serve) reaps as soon as the owner is gone', () => {
  const r = decideReap({ liveConsumerCount: 0, emptySince: null, now: 6000, idleTimeoutMs: 0 })
  assert.deepEqual(r, { emptySince: 6000, reap: true })
})

test('runner params use a restrictive one-shot file instead of exposing the key in argv', async () => {
  await withFakeHome(async () => {
    const paramsPath = await writeRunnerParamsFile(RUNNER_PARAMS)
    const invocation = runnerSpawnSpec(paramsPath)

    assert.equal((await stat(paramsPath)).mode & 0o777, 0o600)
    assert.equal((await readFile(paramsPath, 'utf8')).includes(RUNNER_PARAMS.apiKey), true)
    assert.equal(invocation.args.includes(paramsPath), true)
    assert.equal(
      invocation.args.some((arg) => arg.includes(RUNNER_PARAMS.apiKey)),
      false
    )
    assert.deepEqual(readRunnerParamsFile(paramsPath), RUNNER_PARAMS)
    await assert.rejects(stat(paramsPath), { code: 'ENOENT' })
  })
})
