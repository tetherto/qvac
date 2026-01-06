'use strict'

const test = require('brittle')
const { ModelCache } = require('../../src/utils/modelCache')

// Helper function to create a ModelCache with a unique filename
function createUniqueModelCache (prefix = 'test') {
  const uniqueId = Date.now() + Math.random().toString(36).slice(2, 9)
  return new ModelCache(`${prefix}-${uniqueId}.cache`)
}

test('ModelCache constructor creates singleton', (t) => {
  ModelCache.reset()

  const cache1 = createUniqueModelCache()
  const cache2 = createUniqueModelCache()

  t.is(cache1, cache2, 'should return the same instance')
})

test('ModelCache.getInstance returns singleton', (t) => {
  ModelCache.reset()

  const cache1 = createUniqueModelCache()
  const cache2 = createUniqueModelCache()

  t.is(cache1, cache2, 'should return the same instance')
})

test('ModelCache.addModel adds new model to cache', async (t) => {
  ModelCache.reset()

  const cache = createUniqueModelCache()

  const modelName = 'test-model'

  await cache.addModel(modelName)

  const models = await cache.getModelList()
  t.ok(models.includes(modelName), 'should include added model')
  t.is(models.length, 1, 'should have one model')
})

test('ModelCache.addModel does not add duplicate models', async (t) => {
  ModelCache.reset()

  const cache = createUniqueModelCache()

  const modelName = 'test-model'

  await cache.addModel(modelName)
  await cache.addModel(modelName) // Try to add same model again

  const models = await cache.getModelList()
  t.ok(models.includes(modelName), 'should include model')
  t.is(models.length, 1, 'should have only one instance of model')
})

test('ModelCache.addModel adds multiple different models', async (t) => {
  ModelCache.reset()

  const cache = createUniqueModelCache()

  const model1 = 'test-model-1'
  const model2 = 'test-model-2'
  const model3 = 'test-model-3'

  await cache.addModel(model1)
  await cache.addModel(model2)
  await cache.addModel(model3)

  const models = await cache.getModelList()
  t.ok(models.includes(model1), 'should include model1')
  t.ok(models.includes(model2), 'should include model2')
  t.ok(models.includes(model3), 'should include model3')
  console.log('models', models, cache.cacheFileName)
  t.is(models.length, 3, 'should have three models')
})

test('ModelCache.removeModel removes existing model', async (t) => {
  ModelCache.reset()

  const cache = createUniqueModelCache()

  const model1 = 'test-model-1'
  const model2 = 'test-model-2'

  await cache.addModel(model1)
  await cache.addModel(model2)

  await cache.removeModel(model1)

  const models = await cache.getModelList()
  t.ok(!models.includes(model1), 'should not include removed model')
  t.ok(models.includes(model2), 'should still include other model')
  t.is(models.length, 1, 'should have one model remaining')
})

test('ModelCache.removeModel handles non-existent model gracefully', async (t) => {
  ModelCache.reset()

  const cache = createUniqueModelCache()

  const model1 = 'test-model-1'
  const model2 = 'non-existent-model'

  await cache.addModel(model1)
  await cache.removeModel(model2) // Try to remove non-existent model

  const models = await cache.getModelList()
  t.ok(models.includes(model1), 'should still include existing model')
  t.is(models.length, 1, 'should have one model')
})

test('ModelCache.getModelList returns empty array for non-existent cache file', async (t) => {
  ModelCache.reset()

  const cache = createUniqueModelCache()

  const models = await cache.getModelList()
  t.is(models.length, 0, 'should return empty array')
})

test('ModelCache.getModelList returns empty array for empty cache file', async (t) => {
  ModelCache.reset()

  const cache = createUniqueModelCache()

  // Create empty cache file
  await cache.storage.addFile('empty.cache', '')

  const models = await cache.getModelList()
  t.is(models.length, 0, 'should return empty array for empty file')
})
