'use strict'

const test = require('brittle')
const {
  ADD_MODEL_RPC_TIMEOUT_MS,
  getChanges,
  needsMetadataUpdate,
  recoverAfterAmbiguousAdd,
  isAmbiguousRpcError,
  waitForModelAfterAmbiguousAdd
} = require('../../scripts/sync-models')

const SETTLED = {
  engine: '@qvac/llm-llamacpp',
  licenseId: 'MIT',
  description: '',
  quantization: 'q4_k_m',
  params: '1B',
  notes: '',
  tags: ['generation']
}

function pair(configOverrides = {}, existingOverrides = {}) {
  return [
    { ...SETTLED, ...configOverrides },
    { ...SETTLED, ...existingOverrides }
  ]
}

test('add-model RPC timeout is one hour', (t) => {
  t.is(ADD_MODEL_RPC_TIMEOUT_MS, 60 * 60 * 1000)
})

test('isAmbiguousRpcError identifies transport timeouts and channel closes', (t) => {
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

test('needsMetadataUpdate - a settled model needs no update', (t) => {
  const [config, existing] = pair()
  t.absent(needsMetadataUpdate(config, existing))
})

test('needsMetadataUpdate - unlisting a listed model', (t) => {
  const [config, existing] = pair({ unlisted: true }, { unlisted: false })
  t.ok(needsMetadataUpdate(config, existing))
  t.alike(getChanges(config, existing).unlisted, { from: false, to: true })
})

test('needsMetadataUpdate - re-listing via an explicit false', (t) => {
  const [config, existing] = pair({ unlisted: false }, { unlisted: true })
  t.ok(needsMetadataUpdate(config, existing))
  t.alike(getChanges(config, existing).unlisted, { from: true, to: false })
})

test('needsMetadataUpdate - re-listing by removing the field', (t) => {
  const [config, existing] = pair({}, { unlisted: true })
  t.ok(needsMetadataUpdate(config, existing), 'an omitted flag re-lists an unlisted model')
  t.alike(getChanges(config, existing).unlisted, { from: true, to: false })
})

test('needsMetadataUpdate - an unlisted model still unlisted needs no update', (t) => {
  const [config, existing] = pair({ unlisted: true }, { unlisted: true })
  t.absent(needsMetadataUpdate(config, existing))
  t.absent(getChanges(config, existing).unlisted)
})

test('needsMetadataUpdate - a model that never carried the flag needs no update', (t) => {
  const [config, existing] = pair()
  t.absent(needsMetadataUpdate(config, existing), 'both sides omit the field')

  const [explicitConfig, absentExisting] = pair({ unlisted: false }, {})
  t.absent(
    needsMetadataUpdate(explicitConfig, absentExisting),
    'an explicit false against an absent stored field is not a change'
  )
})
