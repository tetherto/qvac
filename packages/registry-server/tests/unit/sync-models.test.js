'use strict'

const test = require('brittle')
const {
  hasNewModelEntries,
  recoverAfterAmbiguousAdd,
  isAmbiguousRpcError,
  waitForModelAfterAmbiguousAdd
} = require('../../scripts/sync-models')

const MODEL_SOURCE = 'https://huggingface.co/org/repo/resolve/0123456789abcdef/model.gguf'

test('hasNewModelEntries detects a model absent from the registry', (t) => {
  t.ok(hasNewModelEntries([{ source: MODEL_SOURCE }], new Map()))
})

test('hasNewModelEntries ignores metadata-only changes to an existing model', (t) => {
  const dbByKey = new Map([['org/repo/resolve/0123456789abcdef/model.gguf:hf', {}]])

  t.absent(hasNewModelEntries([{ source: MODEL_SOURCE, description: 'Updated metadata' }], dbByKey))
})

test('isAmbiguousRpcError identifies RPC deadlines, transport timeouts and channel closes', (t) => {
  t.ok(
    isAmbiguousRpcError(
      Object.assign(new Error('timeout of 3600000ms exceeded'), { code: 'TIMEOUT_EXCEEDED' })
    )
  )
  t.ok(isAmbiguousRpcError(Object.assign(new Error('connection timed out'), { code: 'ETIMEDOUT' })))
  t.ok(isAmbiguousRpcError(Object.assign(new Error('closed'), { code: 'CHANNEL_CLOSED' })))
  t.ok(isAmbiguousRpcError(new Error('Channel closed')))
  t.absent(isAmbiguousRpcError(new Error('License not found')))
})

test('waitForModelAfterAmbiguousAdd polls until the model appears', async (t) => {
  const expected = { path: 'repo/model.gguf', source: 'hf' }
  const calls = []

  const client = {
    // lunte-disable-next-line require-await
    async getModel(modelPath, source) {
      calls.push([modelPath, source])
      return calls.length === 2 ? expected : null
    }
  }

  const result = await waitForModelAfterAmbiguousAdd({
    client,
    sourceInfo: { path: expected.path, protocol: expected.source },
    timeoutMs: 10,
    pollIntervalMs: 5,
    logger: { info() {} },
    // lunte-disable-next-line require-await
    sleep: async () => {}
  })

  t.alike(result, expected)
  t.alike(calls, [
    [expected.path, expected.source],
    [expected.path, expected.source]
  ])
})

test('ambiguous add recovery stops after one hour independently of the RPC deadline', async (t) => {
  const realNow = Date.now
  let now = 0
  let polls = 0
  Date.now = () => now

  try {
    await t.exception(
      waitForModelAfterAmbiguousAdd({
        client: {
          // lunte-disable-next-line require-await
          async getModel() {
            polls++
            return null
          }
        },
        sourceInfo: { path: 'repo/model.gguf', protocol: 'hf' },
        pollIntervalMs: 15 * 60 * 1000,
        // lunte-disable-next-line require-await
        sleep: async (ms) => {
          now += ms
        }
      }),
      /Timed out waiting for model/
    )
  } finally {
    Date.now = realNow
  }

  t.is(polls, 5, 'polls at 0, 15, 30, 45 and 60 minutes, then stops')
})

test('recoverAfterAmbiguousAdd reconnects even when polling times out', async (t) => {
  t.plan(4)

  const staleConnection = {
    cleaned: false,
    // lunte-disable-next-line require-await
    async cleanup() {
      this.cleaned = true
    }
  }
  const freshConnection = {}
  const pollError = new Error('poll timed out')
  let reconnects = 0

  const result = await recoverAfterAmbiguousAdd({
    client: {},
    sourceInfo: { path: 'repo/model.gguf', protocol: 'hf' },
    logger: { info() {}, warn() {} },
    connection: staleConnection,
    // lunte-disable-next-line require-await
    reconnect: async () => {
      reconnects++
      return freshConnection
    },
    // lunte-disable-next-line require-await
    waitForModel: async () => {
      throw pollError
    }
  })

  t.is(result.error, pollError)
  t.is(result.connection, freshConnection)
  t.is(reconnects, 1)
  t.ok(staleConnection.cleaned)
})
