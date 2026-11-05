import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import test from 'node:test'

import { CliUpgradeRequiredError, ServeExitedError } from '../src/managed/errors.js'
import { healthCheck } from '../src/managed/registry.js'
import { spawnServe, stopServe } from '../src/managed/serve-process.js'
import { fakeServeSkip as skip, makeFakeServe, setBehavior } from './helpers/fake-serve.js'

const API_KEY = 'managed-identity-test-key'

// Another local process holding a port: answers 2xx to everything and records
// any credential it is handed.
async function startSquatter(): Promise<{
  server: Server
  port: number
  authorizations: string[]
}> {
  const authorizations: string[] = []
  const server = createServer((req, res) => {
    if (req.headers.authorization !== undefined) authorizations.push(req.headers.authorization)
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ object: 'list', data: [], proof: 'forged' }))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return { server, port: (server.address() as AddressInfo).port, authorizations }
}

test('a squatter on a pinned port never receives the key', { skip }, async () => {
  const fake = await makeFakeServe()
  const squatter = await startSquatter()
  setBehavior('healthy')
  try {
    await assert.rejects(
      spawnServe({
        apiKey: API_KEY,
        configPath: 'unused.json',
        port: squatter.port,
        serveBinPath: fake.binPath,
        startTimeoutMs: 10_000
      }),
      ServeExitedError
    )
    assert.deepEqual(squatter.authorizations, [])
  } finally {
    setBehavior(undefined)
    squatter.server.close()
    await fake.cleanup()
  }
})

test('healthCheck sends the key only to a listener that proves it holds it', { skip }, async () => {
  const fake = await makeFakeServe()
  const squatter = await startSquatter()
  setBehavior('healthy')
  try {
    const squatted = `http://127.0.0.1:${squatter.port}/v1`
    assert.equal(await healthCheck(squatted, API_KEY, fetch), false)
    assert.deepEqual(squatter.authorizations, [])

    const serve = await spawnServe({
      apiKey: API_KEY,
      configPath: 'unused.json',
      serveBinPath: fake.binPath,
      startTimeoutMs: 10_000
    })
    try {
      assert.equal(await healthCheck(serve.baseURL, API_KEY, fetch), true)
      assert.equal(await healthCheck(serve.baseURL, 'some-other-key', fetch), false)
    } finally {
      await stopServe(serve.child)
    }
  } finally {
    setBehavior(undefined)
    squatter.server.close()
    await fake.cleanup()
  }
})

test('a CLI without --ready-fd fails closed with an upgrade hint', { skip }, async () => {
  const fake = await makeFakeServe()
  setBehavior('no-ready-fd')
  try {
    await assert.rejects(
      spawnServe({
        apiKey: API_KEY,
        configPath: 'unused.json',
        serveBinPath: fake.binPath,
        startTimeoutMs: 10_000
      }),
      (err: unknown) =>
        err instanceof CliUpgradeRequiredError && err.code === 'CLI_UPGRADE_REQUIRED'
    )
  } finally {
    setBehavior(undefined)
    await fake.cleanup()
  }
})
