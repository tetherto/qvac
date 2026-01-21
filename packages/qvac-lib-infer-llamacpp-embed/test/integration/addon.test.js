'use strict'

const test = require('brittle')
const os = require('bare-os')

const {
  createEmbeddingsTestInstance,
  extractErrorMessage,
  waitForCompletion,
  setupErrorHandlers,
  removeErrorHandlers,
  cleanupResources,
  cancelJobIfExists,
  getModelConfigs
} = require('./utils')

const platform = os.platform()

const isDarwinX64 = platform === 'darwin' && os.arch() === 'x64'
const isLinuxArm64 = platform === 'linux' && os.arch() === 'arm64'
const isMobile = platform === 'ios' || platform === 'android'

// Test constants
const TEST_TIMEOUT = 600_000

/**
 * Computes the cosine similarity between two embedding vectors.
 * Returns a value between -1 and 1, where 1 means identical, 0 means orthogonal.
 * @param {number[]|Float32Array} a - First embedding vector
 * @param {number[]|Float32Array} b - Second embedding vector
 * @returns {number} Cosine similarity
 */
function cosineSimilarity (a, b) {
  if (a.length !== b.length) {
    throw new Error(`Vector length mismatch: ${a.length} vs ${b.length}`)
  }
  let dotProduct = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  const denominator = Math.sqrt(normA) * Math.sqrt(normB)
  const EPSILON = 1e-8
  if (denominator < EPSILON) return 1.0 * Math.sign(dotProduct)
  return dotProduct / denominator
}

const DEFAULT_BATCH_SIZE = '1024'
const DEVICES = (isDarwinX64 || isLinuxArm64) ? ['cpu'] : ['cpu', 'gpu'] // Devices to test on
const STRESS_BATCH_SIZE = '4096'
const STRESS_NUM_SEQUENCES = isMobile ? 32 : 256

/**
 * Creates a test wrapper that runs the test for each model and each device (CPU/GPU)
 * @param {string} testName - Base test name
 * @param {Function} testFn - Test function that receives (t, modelName, modelConfig, device)
 */
function createDeviceModelTest (testName, testFn) {
  const modelConfigs = getModelConfigs()

  for (const { modelName, config } of modelConfigs) {
    for (const device of DEVICES) {
      const fullTestName = `${testName} [${modelName}] [${device.toUpperCase()}]`
      test(fullTestName, async (t) => {
        t.timeout(TEST_TIMEOUT)
        await testFn(t, modelName, config, device)
      })
    }
  }
}

createDeviceModelTest('Model inference works correctly', async (t, modelName, modelConfig, device) => {
  const embeddingDimension = modelConfig.embeddingDimension

  console.log(`Creating new GGMLBert instance for ${modelName} on ${device.toUpperCase()}`)
  const { inference, loader } = await createEmbeddingsTestInstance(t, modelName, device, null, DEFAULT_BATCH_SIZE)

  console.log('addon.status():', await inference.status())

  const sentence = 'That is a happy person'
  const response = await inference.run(sentence)
  const embeddings = await waitForCompletion(response)

  t.ok(embeddings[0][0].length === embeddingDimension, 'Should generate embeddings with correct dimension')
  console.log('Generated embeddings:', embeddings[0][0])

  t.teardown(async () => {
    await cleanupResources(loader, inference)
  })
})

createDeviceModelTest('Model inference works correctly with array input', async (t, modelName, modelConfig, device) => {
  const embeddingDimension = modelConfig.embeddingDimension

  console.log(`Creating new GGMLBert instance for array input test [${modelName}] on ${device.toUpperCase()}`)
  const { inference, loader } = await createEmbeddingsTestInstance(t, modelName, device, null, DEFAULT_BATCH_SIZE)

  console.log('addon.status():', await inference.status())

  const sentences = ['That is a happy person', 'This is a sad person', 'I am feeling neutral']
  const response = await inference.run(sentences)
  const embeddings = await waitForCompletion(response)

  // Verify structure: should have one embedding per sentence
  t.ok(embeddings[0].length === sentences.length, `Should generate ${sentences.length} embeddings`)
  console.log(`Generated ${embeddings[0].length} embeddings`)

  // Verify each embedding has correct dimension and type
  for (let i = 0; i < embeddings[0].length; i++) {
    t.ok(embeddings[0][i].length === embeddingDimension, `Embedding ${i} should have dimension ${embeddingDimension}`)
    t.ok(
      Array.isArray(embeddings[0][i]) || embeddings[0][i] instanceof Float32Array,
      `Embedding ${i} should be an array or Float32Array`
    )
    console.log(`Embedding ${i} shape:`, embeddings[0][i].length)
  }

  if (embeddings[0].length > 1) {
    const similarity = cosineSimilarity(embeddings[0][0], embeddings[0][1])
    t.ok(similarity < 0.999, `Different sentences should produce different embeddings (cosine similarity: ${similarity.toFixed(6)})`)
  }

  t.teardown(async () => {
    await cleanupResources(loader, inference)
  })
})

createDeviceModelTest('Model inference works correctly with long string exceeding context size', async (t, modelName, modelConfig, device) => {
  const maxContextSize = modelConfig.maxContextSize

  const { inference, loader } = await createEmbeddingsTestInstance(t, modelName, device, null, DEFAULT_BATCH_SIZE)

  // Create a string that exceeds maxContextSize tokens
  // "Hello world " is approximately 2-3 tokens, repeating enough times to exceed context size
  const repeatCount = Math.ceil((maxContextSize / 2) + 50) // Ensure we exceed the limit
  const longString = 'Hello world '.repeat(repeatCount)

  // Verify that an error is thrown when input exceeds model training context size
  // Expected error: "tokenizeInput: number of tokens in prompt 0 (XXX) exceeds model training context size (XXX)"
  let response = null
  let jobId = null
  let caughtError = null

  try {
    response = await inference.run(longString)
    jobId = response.jobId

    // Set up error handlers to prevent unhandled errors
    // The error will be emitted asynchronously, so we need to catch it here
    setupErrorHandlers(response, (error) => {
      caughtError = error
    })

    // Use await() method like quickstart.js does
    await response.await()
    t.fail(`Should throw an error when input exceeds ${maxContextSize} tokens`)
  } catch (error) {
    caughtError = error
  } finally {
    // Remove event listeners to prevent memory leaks
    if (response) {
      removeErrorHandlers(response)
    }
  }
  // Extract error message from either the caught promise error or the event error
  if (!caughtError) {
    t.fail(`Expected an error to be thrown when input exceeds ${maxContextSize} tokens`)
    return
  }
  // Error may be wrapped in EventEmitterError with the actual error in cause
  // error.cause can be a string or an Error object
  const errorMessage = extractErrorMessage(caughtError)

  // Verify the error message matches expected format
  t.ok(errorMessage.includes('tokenizeInput'), 'Error should mention tokenizeInput')
  t.ok(errorMessage.includes('exceeds model training context size'), 'Error should mention exceeding context size')
  // Verify the error contains token count information
  t.ok(errorMessage.includes(String(maxContextSize)), `Error should mention context size limit (${maxContextSize})`)
  t.ok(/\d+/.test(errorMessage), 'Error should include token count')

  // Wait a bit to ensure all async error emissions are handled
  await new Promise((resolve) => setTimeout(resolve, 100))

  // Clean up: cancel any pending job to prevent it from affecting subsequent tests
  await cancelJobIfExists(inference, jobId)

  t.teardown(async () => {
    await cleanupResources(loader, inference)
  })
})

createDeviceModelTest('Model inference works correctly with array input where one sequence exceeds context size', async (t, modelName, modelConfig, device) => {
  const maxContextSize = modelConfig.maxContextSize

  const { inference, loader } = await createEmbeddingsTestInstance(t, modelName, device, null, DEFAULT_BATCH_SIZE)

  // Create an array with 3 sequences where the second sequence exceeds context size
  // "Hello world " is approximately 2-3 tokens, repeating enough times to exceed context size
  const repeatCount = Math.ceil((maxContextSize / 2) + 50) // Ensure we exceed the limit
  const sequences = [
    'This is a short first sequence',
    'Hello world '.repeat(repeatCount), // This sequence exceeds context size
    'This is a short third sequence'
  ]

  // Verify that an error is thrown when one sequence exceeds model training context size
  // Expected error: "encode_host_f32_sequences: number of tokens in sequence 1 (XXX)
  // exceeds model training context size (XXX)"
  let response = null
  let jobId = null
  let caughtError = null

  try {
    response = await inference.run(sequences)
    jobId = response.jobId

    setupErrorHandlers(response, (error) => {
      caughtError = error
    })

    await response.await()
    t.fail(`Should throw an error when one sequence exceeds ${maxContextSize} tokens`)
  } catch (error) {
    caughtError = error
  } finally {
    // Remove event listeners to prevent memory leaks
    if (response) {
      removeErrorHandlers(response)
    }
  }

  if (!caughtError) {
    t.fail(`Expected an error to be thrown when one sequence exceeds ${maxContextSize} tokens`)
    return
  }

  const errorMessage = extractErrorMessage(caughtError)

  // Verify the error message matches the expected format
  // The error should mention encode_host_f32_sequences (for array input)
  // or tokenizeInput (transformed) It should also mention which sequence is failing (sequence 1)
  const hasEncodeError = errorMessage.includes('encode_host_f32_sequences')
  const hasTokenizeError = errorMessage.includes('tokenizeInput')
  t.ok(hasEncodeError || hasTokenizeError, 'Error should mention encode_host_f32_sequences or tokenizeInput')
  t.ok(errorMessage.includes('exceeds model training context size'), 'Error should mention exceeding context size')
  t.ok(errorMessage.includes(String(maxContextSize)), `Error should mention context size limit (${maxContextSize})`)
  t.ok(/\d+/.test(errorMessage), 'Error should include token count')
  // Verify the error mentions which sequence is failing (sequence 1)
  // The error might say "sequence 1" or "prompt 0" depending on transformation
  t.ok(/sequence\s+1|prompt\s+0/.test(errorMessage), 'Error should mention which sequence is failing')

  // Wait a bit to ensure all async error emissions are handled
  await new Promise((resolve) => setTimeout(resolve, 100))

  await cancelJobIfExists(inference, jobId)

  t.teardown(async () => {
    await cleanupResources(loader, inference)
  })
})

createDeviceModelTest('Model inference works correctly with batching - 5 sequences split into 2 batches', async (t, modelName, modelConfig, device) => {
  const embeddingDimension = modelConfig.embeddingDimension
  const maxContextSize = modelConfig.maxContextSize

  console.log(`Creating new GGMLBert instance for batching test [${modelName}] on ${device.toUpperCase()}`)
  const { inference, loader } = await createEmbeddingsTestInstance(t, modelName, device, null, DEFAULT_BATCH_SIZE)

  console.log('addon.status():', await inference.status())

  // Create 5 sequences of roughly similar length.
  // The goal is to have enough total tokens so that:
  // - The first 3 sequences fit into the first batch (within maxContextSize)
  // - The remaining 2 sequences overflow into a second batch
  //
  // repeatCount is derived from maxContextSize so that each sequence is long enough
  // to contribute a meaningful number of tokens, and the total of all 5 sequences
  // is larger than a single context window. The exact token counts are only approximate.
  const repeatCount = Math.ceil((maxContextSize / 6) + 50)

  const sequences = [
    'Hello world '.repeat(repeatCount), // Sequence 0
    'Hello there '.repeat(repeatCount), // Sequence 1
    'Hello again '.repeat(repeatCount), // Sequence 2 (still first batch)
    'Hello other '.repeat(repeatCount), // Sequence 3 (starts second batch)
    'Hello earth '.repeat(repeatCount) // Sequence 4 (continues second batch)
  ]

  console.log(`Created ${sequences.length} sequences for batching test`)
  console.log(`Sequence lengths: ${sequences.map((s) => s.length).join(', ')}`)

  const response = await inference.run(sequences)
  const embeddings = await waitForCompletion(response)

  // Verify we got embeddings for all sequences
  t.ok(embeddings[0].length === sequences.length, `Should generate ${sequences.length} embeddings (one per sequence)`)
  console.log(`Generated ${embeddings[0].length} embeddings`)

  // Verify each embedding has correct dimension and type
  for (let i = 0; i < embeddings[0].length; i++) {
    t.ok(embeddings[0][i].length === embeddingDimension, `Embedding ${i} should have dimension ${embeddingDimension}`)
    t.ok(
      Array.isArray(embeddings[0][i]) || embeddings[0][i] instanceof Float32Array,
      `Embedding ${i} should be an array or Float32Array`
    )
  }

  if (embeddings[0].length > 1) {
    const similarity = cosineSimilarity(embeddings[0][0], embeddings[0][1])
    t.ok(similarity < 0.999, `Different sequences should produce different embeddings (cosine similarity: ${similarity.toFixed(6)})`)
  }

  t.teardown(async () => {
    await cleanupResources(loader, inference)
  })
})

createDeviceModelTest('Embeddings: empty string input', async (t, modelName, modelConfig, device) => {
  const { inference, loader } = await createEmbeddingsTestInstance(t, modelName, device, null, DEFAULT_BATCH_SIZE)

  const sentence = ''
  const response = await inference.run(sentence)
  const embeddings = await waitForCompletion(response)

  // Verify structure exists - embeddings should be an array
  t.ok(Array.isArray(embeddings), 'Embeddings should be an array')

  // Empty string should result in empty embeddings array
  if (embeddings.length === 0) {
    // Empty string resulted in no embeddings (expected behavior)
    t.pass('Empty string resulted in empty embeddings array (expected behavior)')
  }

  t.teardown(async () => {
    await cleanupResources(loader, inference)
  })
})

createDeviceModelTest('Embeddings: whitespace-only string input', async (t, modelName, modelConfig, device) => {
  const embeddingDimension = modelConfig.embeddingDimension

  const { inference, loader } = await createEmbeddingsTestInstance(t, modelName, device, null, DEFAULT_BATCH_SIZE)

  const sentence = ' \t  \n  '
  const response = await inference.run(sentence)
  const embeddings = await waitForCompletion(response)

  t.ok(
    embeddings[0][0].length === embeddingDimension,
    `Whitespace-only string should produce ${embeddingDimension}-dim embedding`
  )

  t.teardown(async () => {
    await cleanupResources(loader, inference)
  })
})

createDeviceModelTest('Embeddings: unicode / multilingual input with emojis', async (t, modelName, modelConfig, device) => {
  const embeddingDimension = modelConfig.embeddingDimension

  const { inference, loader } = await createEmbeddingsTestInstance(t, modelName, device, null, DEFAULT_BATCH_SIZE)

  const sentences = ['Привет, как дела? 😊', '你好，世界 🌏', 'Hola, ¿cómo estás? ❤️', 'Hello, world! 🚀']
  const response = await inference.run(sentences)
  const embeddings = await waitForCompletion(response)

  t.ok(embeddings[0].length === sentences.length, 'Should generate one embedding per multilingual sentence')

  for (let i = 0; i < embeddings[0].length; i++) {
    t.ok(embeddings[0][i].length === embeddingDimension, `Embedding ${i} should have dimension ${embeddingDimension}`)
  }

  t.teardown(async () => {
    await cleanupResources(loader, inference)
  })
})

createDeviceModelTest('Embeddings: deterministic output for same input', async (t, modelName, modelConfig, device) => {
  const embeddingDimension = modelConfig.embeddingDimension

  const { inference, loader } = await createEmbeddingsTestInstance(t, modelName, device, null, DEFAULT_BATCH_SIZE)

  const sentence = 'This sentence should always map to the same embedding.'

  const response1 = await inference.run(sentence)
  const emb1 = (await waitForCompletion(response1))[0][0]

  const response2 = await inference.run(sentence)
  const emb2 = (await waitForCompletion(response2))[0][0]

  t.ok(emb1.length === embeddingDimension, 'First embedding should be correct dimension')
  t.ok(emb2.length === embeddingDimension, 'Second embedding should be correct dimension')

  let allEqual = true
  for (let i = 0; i < emb1.length; i++) {
    if (emb1[i] !== emb2[i]) {
      allEqual = false
      break
    }
  }
  t.ok(allEqual, 'Same input should produce identical embeddings (deterministic behaviour)')

  const similarity = cosineSimilarity(emb1, emb2)
  t.ok(similarity > 0.999, `Same input should produce identical embeddings (cosine similarity: ${similarity.toFixed(6)})`)

  t.teardown(async () => {
    await cleanupResources(loader, inference)
  })
})

createDeviceModelTest(`Stress: inference with large batch size ${STRESS_BATCH_SIZE}`, async (t, modelName, modelConfig, device) => {
  const embeddingDimension = modelConfig.embeddingDimension

  console.log(
    `Creating GGMLBert instance for large batch size stress test [${modelName}] on ${device.toUpperCase()} ` +
    `(batch_size=${STRESS_BATCH_SIZE})`
  )

  const { inference, loader } = await createEmbeddingsTestInstance(
    t,
    modelName,
    device,
    null,
    STRESS_BATCH_SIZE
  )

  console.log('addon.status():', await inference.status())

  const sentence = 'This is a stress test sentence for large batch size configuration.'.repeat(5)
  const query = Array(60).fill(sentence)

  try {
    const response = await inference.run(query)
    const embeddings = await waitForCompletion(response)

    t.ok(
      embeddings[0][0].length === embeddingDimension,
      `Large batch size should still produce ${embeddingDimension}-dim embedding`
    )
  } catch (error) {
    // Test passes if the specific "Failed to get sequence embeddings" exception is thrown
    if (error.message && error.message.includes('Failed to get sequence embeddings')) {
      t.pass('Test passed: Expected exception "Failed to get sequence embeddings" was thrown')
    } else {
      // Re-throw if it's a different exception
      throw error
    }
  }

  t.teardown(async () => {
    await cleanupResources(loader, inference)
  })
})

createDeviceModelTest(`Stress: inference with many sequences (~${STRESS_NUM_SEQUENCES})`, async (t, modelName, modelConfig, device) => {
  const embeddingDimension = modelConfig.embeddingDimension

  console.log(
    `Creating GGMLBert instance for many-sequences stress test [${modelName}] on ${device.toUpperCase()} ` +
    `(num_sequences=${STRESS_NUM_SEQUENCES})`
  )

  const { inference, loader } = await createEmbeddingsTestInstance(
    t,
    modelName,
    device,
    null,
    DEFAULT_BATCH_SIZE
  )

  console.log('addon.status():', await inference.status())

  const sequences = new Array(STRESS_NUM_SEQUENCES)
    .fill(null)
    .map((_, i) => `Stress test sequence #${i} for model ${modelName} on ${device}`)

  const response = await inference.run(sequences)
  const embeddings = await waitForCompletion(response)

  t.ok(
    embeddings[0].length === STRESS_NUM_SEQUENCES,
    `Should generate ${STRESS_NUM_SEQUENCES} embeddings (one per stress test sequence)`
  )

  const indicesToCheck = [0, Math.floor(STRESS_NUM_SEQUENCES / 2), STRESS_NUM_SEQUENCES - 1]

  for (const idx of indicesToCheck) {
    t.ok(
      embeddings[0][idx].length === embeddingDimension,
      `Embedding ${idx} should have dimension ${embeddingDimension}`
    )
    t.ok(
      Array.isArray(embeddings[0][idx]) || embeddings[0][idx] instanceof Float32Array,
      `Embedding ${idx} should be an array or Float32Array`
    )
  }

  if (embeddings[0].length > 1) {
    const similarity = cosineSimilarity(embeddings[0][0], embeddings[0][1])
    t.ok(similarity < 0.999, `Different stress test sequences should produce different embeddings (cosine similarity: ${similarity.toFixed(6)})`)
  }

  t.teardown(async () => {
    await cleanupResources(loader, inference)
  })
})
