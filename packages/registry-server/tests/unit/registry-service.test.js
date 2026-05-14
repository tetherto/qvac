'use strict'

const test = require('brittle')
const RegistryService = require('../../lib/registry-service')
const { isTransientHfDownloadError } = RegistryService

test('RegistryService.listModels returns HyperDB results', async t => {
  t.plan(1)

  const expectedQuery = { foo: 'bar' }
  const expectedModels = [{ name: 'model-a' }]

  const service = createServiceWithRpc()
  service.view = {
    opened: true,
    findModelsByPath: () => ({
      toArray: async () => expectedModels
    })
  }
  const result = await service.listModels(expectedQuery)
  t.alike(result, expectedModels)
})

test('RegistryService.getModelByKey resolves from HyperDB', async t => {
  t.plan(1)

  const lookup = { path: 'foo/bar.bin', source: 's3' }
  const expectedModel = { ...lookup, engine: '@qvac/test' }

  const service = createServiceWithRpc()
  service.view = {
    opened: true,
    getModel: async () => expectedModel
  }
  const result = await service.getModelByKey(lookup)
  t.alike(result, expectedModel)
})

test('RegistryService.getModelByKey validates input', async t => {
  const service = createServiceWithRpc()

  const assertThrows = async (payload) => {
    try {
      await service.getModelByKey(payload)
      t.fail('Expected getModelByKey to throw')
    } catch (err) {
      t.ok(err instanceof TypeError)
    }
  }

  await assertThrows({})
  await assertThrows({ path: null })
  await assertThrows({ path: '' })
})

test('isTransientHfDownloadError retries on undici socket errors', t => {
  for (const code of [
    'ECONNRESET',
    'ECONNREFUSED',
    'ETIMEDOUT',
    'EAI_AGAIN',
    'UND_ERR_SOCKET',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_BODY_TIMEOUT',
    'UND_ERR_HEADERS_TIMEOUT'
  ]) {
    const err = Object.assign(new Error(`mock ${code}`), { code })
    t.ok(isTransientHfDownloadError(err), `retries on ${code}`)
  }
})

test('isTransientHfDownloadError unwraps fetch `cause` for net codes', t => {
  const err = new Error('fetch failed')
  err.cause = Object.assign(new Error('socket reset'), { code: 'ECONNRESET' })
  t.ok(isTransientHfDownloadError(err))
})

test('isTransientHfDownloadError matches undici raw "terminated" / "socket hang up" messages', t => {
  t.ok(isTransientHfDownloadError(new Error('terminated')))
  t.ok(isTransientHfDownloadError(new Error('Socket hang up')))
})

test('isTransientHfDownloadError retries HF 5xx and 429', t => {
  for (const statusCode of [429, 500, 502, 503, 504]) {
    const err = Object.assign(new Error(`Api error with status ${statusCode}`), { statusCode })
    t.ok(isTransientHfDownloadError(err), `retries HF ${statusCode}`)
  }
})

test('isTransientHfDownloadError fast-fails on HF 4xx (auth/license/missing)', t => {
  for (const statusCode of [400, 401, 403, 404, 422]) {
    const err = Object.assign(new Error(`Api error with status ${statusCode}`), { statusCode })
    t.absent(isTransientHfDownloadError(err), `fast-fails HF ${statusCode}`)
  }
})

test('isTransientHfDownloadError fast-fails on unknown / unstructured errors', t => {
  t.absent(isTransientHfDownloadError(new Error('Invalid HuggingFace URL')))
  t.absent(isTransientHfDownloadError(new TypeError('cannot read property of undefined')))
  t.absent(isTransientHfDownloadError(Object.assign(new Error('something'), { code: 'SOME_UNKNOWN_CODE' })))
  t.absent(isTransientHfDownloadError(null))
  t.absent(isTransientHfDownloadError(undefined))
})

function createServiceWithRpc () {
  const service = Object.create(RegistryService.prototype)
  service.logger = { warn () {} }
  return service
}
