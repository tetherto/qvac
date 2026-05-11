'use strict'

const test = require('brittle')
const RegistryService = require('../../lib/registry-service')

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

function createServiceWithRpc () {
  const service = Object.create(RegistryService.prototype)
  service.logger = { warn () {} }
  return service
}
