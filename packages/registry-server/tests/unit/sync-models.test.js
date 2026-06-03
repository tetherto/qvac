'use strict'

const test = require('brittle')
const {
  ADD_MODEL_RPC_TIMEOUT_MS,
  recoverAfterAmbiguousAdd,
  isAmbiguousRpcError,
  waitForModelAfterAmbiguousAdd
} = require('../../scripts/sync-models')

test('add-model RPC timeout is one hour', t => {
  t.is(ADD_MODEL_RPC_TIMEOUT_MS, 60 * 60 * 1000)
})

test('isAmbiguousRpcError identifies transport timeouts and channel closes', t => {
  t.ok(isAmbiguousRpcError(Object.assign(new Error('connection timed out'), { code: 'ETIMEDOUT' })))
  t.ok(isAmbiguousRpcError(Object.assign(new Error('closed'), { code: 'CHANNEL_CLOSED' })))
  t.ok(isAmbiguousRpcError(new Error('Channel closed')))
  t.absent(isAmbiguousRpcError(new Error('License not found')))
})

test('waitForModelAfterAmbiguousAdd polls until the model appears', async t => {
  const expected = { path: 'repo/model.gguf', source: 'hf' }
  const calls = []

  const client = {
    async getModel (modelPath, source) {
      calls.push([modelPath, source])
      return calls.length === 2 ? expected : null
    }
  }

  const result = await waitForModelAfterAmbiguousAdd({
    client,
    sourceInfo: { path: expected.path, protocol: expected.source },
    timeoutMs: 10,
    pollIntervalMs: 5,
    logger: { info () {} },
    sleep: async () => {}
  })

  t.alike(result, expected)
  t.alike(calls, [
    [expected.path, expected.source],
    [expected.path, expected.source]
  ])
})

test('recoverAfterAmbiguousAdd reconnects even when polling times out', async t => {
  t.plan(4)

  const staleConnection = {
    cleaned: false,
    async cleanup () {
      this.cleaned = true
    }
  }
  const freshConnection = {}
  const pollError = new Error('poll timed out')
  let reconnects = 0

  const result = await recoverAfterAmbiguousAdd({
    client: {},
    sourceInfo: { path: 'repo/model.gguf', protocol: 'hf' },
    logger: { info () {}, warn () {} },
    connection: staleConnection,
    reconnect: async () => {
      reconnects++
      return freshConnection
    },
    waitForModel: async () => {
      throw pollError
    }
  })

  t.is(result.error, pollError)
  t.is(result.connection, freshConnection)
  t.is(reconnects, 1)
  t.ok(staleConnection.cleaned)
})
