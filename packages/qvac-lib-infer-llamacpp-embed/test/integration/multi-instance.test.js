'use strict'

const test = require('brittle')
const os = require('bare-os')
const { createEmbeddingsTestInstance, getModelConfigs, waitForCompletion } = require('./utils')

const platform = os.platform()
const arch = os.arch()
const isDarwinX64 = platform === 'darwin' && arch === 'x64'
const isLinuxArm64 = platform === 'linux' && arch === 'arm64'
const DEFAULT_DEVICE = (isDarwinX64 || isLinuxArm64) ? 'cpu' : 'gpu'

const DEFAULT_BATCH_SIZE = '1024'

const TEST_MODEL = getModelConfigs()[0]

test('Two embed instances can run inference simultaneously', {
  timeout: 900_000
}, async t => {
  const modelName = TEST_MODEL.modelName
  const { inference: inference1 } = await createEmbeddingsTestInstance(
    t,
    modelName,
    DEFAULT_DEVICE,
    null,
    DEFAULT_BATCH_SIZE
  )
  const { inference: inference2 } = await createEmbeddingsTestInstance(
    t,
    modelName,
    DEFAULT_DEVICE,
    null,
    DEFAULT_BATCH_SIZE
  )

  t.teardown(async () => {
    await inference1.unload().catch(() => {})
    await inference2.unload().catch(() => {})
  })

  const sentences1 = ['Hello world', 'This is a test']
  const sentences2 = ['Goodbye world', 'Another test sentence']
  const response1 = await inference1.run(sentences1)
  const response2 = await inference2.run(sentences2)

  const [embeddings1, embeddings2] = await Promise.all([
    waitForCompletion(response1),
    waitForCompletion(response2)
  ])

  t.ok(embeddings1[0].length === sentences1.length, 'first instance produced correct number of embeddings')
  t.ok(embeddings2[0].length === sentences2.length, 'second instance produced correct number of embeddings')
  t.ok(embeddings1[0][0].length > 0, 'first instance embeddings have correct dimension')
  t.ok(embeddings2[0][0].length > 0, 'second instance embeddings have correct dimension')
})

test('Repeated embed load/unload cycles should remain stable', {
  timeout: 900_000
}, async t => {
  const modelName = TEST_MODEL.modelName

  const NUM_CYCLES = 6
  const testSentence = 'This is a stability test sentence.'

  for (let i = 0; i < NUM_CYCLES; i++) {
    const { inference } = await createEmbeddingsTestInstance(
      t,
      modelName,
      DEFAULT_DEVICE,
      null,
      DEFAULT_BATCH_SIZE
    )

    const response = await inference.run(testSentence)
    const embeddings = await waitForCompletion(response)

    t.ok(embeddings[0][0].length > 0, `cycle ${i + 1}: produced embeddings`)

    await inference.unload()

    t.pass(`cycle ${i + 1}: load/unload completed`)
  }

  t.pass(`all ${NUM_CYCLES} load/unload cycles completed successfully`)
})

test('Unloading one embed instance does not affect another running instance', {
  timeout: 900_000
}, async t => {
  const modelName = TEST_MODEL.modelName
  const { inference: inference1 } = await createEmbeddingsTestInstance(
    t,
    modelName,
    DEFAULT_DEVICE,
    null,
    DEFAULT_BATCH_SIZE
  )
  const { inference: inference2 } = await createEmbeddingsTestInstance(
    t,
    modelName,
    DEFAULT_DEVICE,
    null,
    DEFAULT_BATCH_SIZE
  )

  t.teardown(async () => {
    await inference1.unload().catch(() => {})
    await inference2.unload().catch(() => {})
  })

  const largeBatch = Array(50).fill(null).map((_, i) => `Test sentence number ${i} for batch processing`)
  const response1Promise = inference1.run(largeBatch)

  await new Promise(resolve => setTimeout(resolve, 100))

  await inference2.unload()
  t.pass('unloaded instance 2 while instance 1 is processing')

  const response1 = await response1Promise
  const embeddings1 = await waitForCompletion(response1)

  t.ok(embeddings1[0].length === largeBatch.length, 'instance 1 completed processing after instance 2 was unloaded')
})

test('Multiple embed load/unload cycles on one instance while another processes', {
  timeout: 900_000
}, async t => {
  const modelName = TEST_MODEL.modelName
  const { inference: inference1 } = await createEmbeddingsTestInstance(
    t,
    modelName,
    DEFAULT_DEVICE,
    null,
    DEFAULT_BATCH_SIZE
  )

  t.teardown(async () => {
    await inference1.unload().catch(() => {})
  })

  const NUM_CYCLES = 3
  const NUM_BATCHES = 5
  let cyclesCompleted = 0

  for (let batch = 0; batch < NUM_BATCHES; batch++) {
    const sentences = Array(10).fill(null).map((_, i) => `Batch ${batch} sentence ${i}`)
    const response1Promise = inference1.run(sentences)

    if (cyclesCompleted < NUM_CYCLES) {
      const { inference: inference2 } = await createEmbeddingsTestInstance(
        t,
        modelName,
        DEFAULT_DEVICE,
        null,
        DEFAULT_BATCH_SIZE
      )
      await inference2.unload()
      cyclesCompleted++
      t.pass(`load/unload cycle ${cyclesCompleted} completed while instance 1 processes batch ${batch + 1}`)
    }

    const response1 = await response1Promise
    const embeddings1 = await waitForCompletion(response1)
    t.ok(embeddings1[0].length === sentences.length, `batch ${batch + 1} completed with correct count`)
  }

  t.ok(cyclesCompleted === NUM_CYCLES, `completed ${cyclesCompleted} load/unload cycles during processing`)
})

setImmediate(() => {
  setTimeout(() => {}, 500)
})
