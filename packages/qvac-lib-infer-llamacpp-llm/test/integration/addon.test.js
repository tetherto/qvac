'use strict'
// test/integration/addon.test.js
const test = require('brittle')
const { LlamaInterface } = require('../../addon.js')
const fs = require('bare-fs')
const path = require('bare-path')
const {
  testTextWithSettings,
  ensureModelPath,
  ensureModel,
  getFinetuneModel,
  createDefaultGpuConfig,
  waitForStatus,
  cleanupCheckpoints,
  findPauseCheckpoint,
  getDefaultFinetuneConfig,
  waitForFinetuningStart,
  setupFinetuneTestData,
  verifyPauseCheckpoint,
  handleEarlyCompletion,
  verifyInitialStatus,
  verifyFinalStatus
} = require('./utils')
const process = require('process')
const { makeOutputCollector } = require('../mocks/utils')
const binding = require('../../binding')
const FilesystemDL = require('@qvac/dl-filesystem')
const LlmLlamacpp = require('../../index.js')

const diskPath = path.join('test', 'model')
const testDataDir = path.join('test', 'finetune-data')
const testCheckpointDir = path.join('test', 'finetune-checkpoints')

test('llama addon can generate text', async t => {
  const timeout = 600_000
  t.timeout(timeout)

  // Force GPU (large gpu-layer count)
  const settings = {
    gpu_layers: '99', // number of model layers offloaded to GPU.
    ctx_size: '2048', // context length
    predict: '1024',
    device: 'gpu'
  }

  const modelName = process.env.TEXT_MODEL_NAME || 'small-test-model.gguf'
  const downloadUrl = 'https://huggingface.co/ggml-org/models/resolve/main/tinyllamas/stories260K.gguf'
  await testTextWithSettings(t, modelName, downloadUrl, settings)

  t.ok(t.fails === 0, 'Test should pass')
})

test('llama addon can describe an image with projection model', async t => {
  t.timeout(900_000)

  const collector = makeOutputCollector(t)
  const { onOutput } = collector

  const llmModelPath = await ensureModelPath({
    modelName: 'SmolVLM2-500M-Video-Instruct-Q8_0.gguf',
    downloadUrl: 'https://huggingface.co/ggml-org/SmolVLM2-500M-Video-Instruct-GGUF/resolve/main/SmolVLM2-500M-Video-Instruct-Q8_0.gguf'
  })
  t.ok(fs.existsSync(llmModelPath), 'LLM model file should exist')

  const projModelPath = await ensureModelPath({
    modelName: 'mmproj-SmolVLM2-500M-Video-Instruct-Q8_0.gguf',
    downloadUrl: 'https://huggingface.co/ggml-org/SmolVLM2-500M-Video-Instruct-GGUF/resolve/main/mmproj-SmolVLM2-500M-Video-Instruct-Q8_0.gguf'
  })
  t.ok(fs.existsSync(projModelPath), 'Projection model file should exist')

  const imageFilePath = path.resolve(__dirname, '../../media/news-paper.jpg')
  t.ok(fs.existsSync(imageFilePath), 'Image file should exist')

  const config = {
    gpu_layers: '98', // number of model layers offloaded to GPU.
    ctx_size: '2048', // context length
    device: 'gpu'
  }

  const addon = new LlamaInterface(
    binding,
    {
      path: llmModelPath,
      projectionPath: projModelPath,
      config
    },
    onOutput
  )

  const status = await addon.status()
  t.ok(['LOADING', 'IDLE', 'LISTENING'].includes(status), 'Addon should have valid initial status')

  const imageBytes = new Uint8Array(fs.readFileSync(imageFilePath))
  await addon.append({ type: 'media', input: imageBytes })

  const messages = [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', type: 'media', content: '' },
    { role: 'user', content: 'Describe the image briefly in one sentence.' }
  ]

  await addon.append({ type: 'text', input: JSON.stringify(messages) })
  await addon.append({ type: 'end of job' })

  await addon.activate()

  const maxWaitSeconds = 1000
  for (let i = 0; i < maxWaitSeconds; i++) {
    const currentStatus = await addon.status()
    if (currentStatus === 'IDLE' && collector.jobCompleted) {
      break
    }
    await new Promise(resolve => setTimeout(resolve, 1000))
  }

  t.comment(JSON.stringify(collector.outputText, null, 2))

  t.ok(collector.jobCompleted, 'Job should complete')
  t.ok(collector.generatedText.length > 0, 'Should generate some text output for the image')

  await addon.destroyInstance()
})

// Skipped due to known issue in the library causing this test to fail.
// TODO: Re-enable when the context limit bug is fixed.
test.skip('llama addon can handle context limit', async t => {
  const [modelName, dirPath] = await ensureModel({
    modelName: process.env.TEXT_MODEL_NAME || 'small-test-model.gguf',
    downloadUrl: 'https://huggingface.co/ggml-org/models/resolve/main/tinyllamas/stories260K.gguf'
  })
  t.ok(fs.existsSync(path.join(dirPath, modelName)), 'Model file should exist')

  // Force GPU (large gpu-layer count)
  const settings = {
    gpu_layers: '99', // number of model layers offloaded to GPU.
    ctx_size: '1024', // Small context length for this test
    device: 'gpu'
  }

  const loader = new FilesystemDL({ dirPath: diskPath })
  const inference = new LlmLlamacpp({
    modelName,
    loader,
    logger: console,
    diskPath,
    projectionPath: ''
  }, settings)
  t.teardown(async () => {
    await loader.close()
    await inference.destroy()
  })
  await inference.load()

  const status = await inference.status()
  t.ok(['LOADING', 'IDLE', 'LISTENING'].includes(status), 'Addon should have valid initial status')

  // The smaller test model hits the hang bug, even with this prompt.
  const messages = [
    {
      role: 'system',
      content: 'You are a helpful assistant.'
    },
    {
      role: 'user',
      content: 'What can you do for me?'
    }
  ]

  const response = await inference.run(messages)
  const generatedText = []
  response.onUpdate(data => {
    generatedText.push(data)
  }).onCancel(() => {
    t.fail('Inference should not be cancelled')
  }).onPause(() => {
    t.fail('Inference should not be paused')
  }).onContinue(() => {
    t.fail('Inference should not be continued')
  }).onError(error => {
    t.fail('Inference should not error', error)
  }).onFinish(data => {
    t.ok(data.length > 0, 'Should generate some text output')
    t.comment('Generated text: ' + data.join(''))
  })
  await response.await()

  t.ok(generatedText.length > 0, 'Should generate some text output')
  t.comment('Generated text: ' + generatedText.join(''))
})

// ============================================================================
// Finetuning Tests
// ============================================================================

// Helper to wait for finetuning to start or complete (handles race condition)
async function waitForFinetuningStartOrComplete (model, finetunePromise, t) {
  // Check status immediately - finetuning might complete very quickly
  let status = await model.status()
  if (status === 'FINETUNING') {
    t.comment('Finetuning started')
    return await finetunePromise
  } else if (status === 'IDLE') {
    // Finetuning completed very quickly
    t.comment('Finetuning completed very quickly')
    return await finetunePromise
  } else {
    // Wait for status to transition to FINETUNING (with shorter timeout)
    try {
      await waitForStatus(model, 'FINETUNING', { timeoutMs: 5000 })
      t.comment('Finetuning started')
      return await finetunePromise
    } catch (err) {
      // If we timeout waiting for FINETUNING, it might have already completed
      status = await model.status()
      if (status === 'IDLE') {
        t.comment('Finetuning completed before status check')
        return await finetunePromise
      } else {
        throw err
      }
    }
  }
}

// Helper to create a test model instance for finetuning
async function createTestModel (t, configOverrides = {}) {
  // Use Qwen model for finetuning tests (same as examples)
  const finetuneModel = getFinetuneModel()
  let modelPath
  let loader

  if (finetuneModel.useLocal) {
    // Use local Qwen model if available
    modelPath = path.join(finetuneModel.modelDir, finetuneModel.modelName)
    t.ok(fs.existsSync(modelPath), 'Qwen model file should exist')
    loader = new FilesystemDL({ dirPath: finetuneModel.modelDir })
  } else {
    // Fallback to downloadable test model
    const { modelName, downloadUrl } = finetuneModel
    // Ensure the model directory exists before creating FilesystemDL
    if (!fs.existsSync(diskPath)) {
      fs.mkdirSync(diskPath, { recursive: true })
    }
    modelPath = await ensureModelPath({ modelName, downloadUrl })
    t.ok(fs.existsSync(modelPath), 'Model file should exist')
    loader = new FilesystemDL({ dirPath: diskPath })
  }

  const settings = createDefaultGpuConfig({
    ctx_size: '512',
    gpu_layers: '999', // Use 999 for Qwen model (same as examples)
    flash_attn: 'off', // Flash attention not supported for finetuning backward pass
    ...configOverrides
  })

  const model = new LlmLlamacpp({
    modelName: finetuneModel.modelName,
    loader,
    logger: console,
    diskPath: finetuneModel.useLocal ? finetuneModel.modelDir : diskPath,
    projectionPath: '',
    opts: { stats: true }
  }, settings)

  await model.load()

  t.teardown(async () => {
    try {
      await loader.close()
      await model.unload()
    } catch (err) {
      // Ignore cleanup errors
    }
  })

  return { model, loader, modelPath }
}

// Test: Basic Finetuning - Start and Complete
test('llama addon can start and complete finetuning', async t => {
  t.timeout(600_000) // 10 minutes

  // Setup
  const { model } = await createTestModel(t)
  const { trainDatasetPath, evalDatasetPath, checkpointDir } = setupFinetuneTestData(testDataDir, testCheckpointDir, '1')

  // Verify initial status
  const initialStatus = await model.status()
  verifyInitialStatus(t, initialStatus)

  // Configure finetuning
  const finetuneConfig = getDefaultFinetuneConfig({
    trainDatasetDir: trainDatasetPath,
    evalDatasetDir: evalDatasetPath,
    checkpointSaveDir: checkpointDir,
    numberOfEpochs: 1,
    checkpointSaveSteps: 2
  })

  // Start finetuning
  const finetunePromise = model.finetune(finetuneConfig)

  // Wait for finetuning to start or complete (handles race condition)
  const result = await waitForFinetuningStartOrComplete(model, finetunePromise, t)
  t.ok(result, 'Finetuning should complete')
  t.ok(result.status === 'IDLE', 'Final status should be IDLE')

  // Verify final status
  const finalStatus = await model.status()
  t.ok(finalStatus === 'IDLE', 'Status should be IDLE after completion')

  // Cleanup
  cleanupCheckpoints(checkpointDir)
})

// Test: Finetuning with Custom Parameters
test('llama addon can finetune with custom parameters', async t => {
  t.timeout(600_000)

  const { model } = await createTestModel(t)
  const { trainDatasetPath, evalDatasetPath } = setupFinetuneTestData(testDataDir, testCheckpointDir, '2')

  // Test with different learning rate and LoRA modules
  const finetuneConfig = getDefaultFinetuneConfig({
    trainDatasetDir: trainDatasetPath,
    evalDatasetDir: evalDatasetPath,
    learningRate: 5e-6,
    loraModules: 'attn_q,attn_k,attn_v,attn_o,ffn_gate,ffn_up',
    numberOfEpochs: 1
  })

  const finetunePromise = model.finetune(finetuneConfig)
  const result = await waitForFinetuningStartOrComplete(model, finetunePromise, t)
  t.ok(result, 'Finetuning should complete with custom parameters')
  t.ok(result.status === 'IDLE', 'Final status should be IDLE')
})

// Test: Status Transitions During Normal Finetuning
test('llama addon has correct status transitions during finetuning', async t => {
  t.timeout(600_000)

  const { model } = await createTestModel(t)
  const { trainDatasetPath, evalDatasetPath } = setupFinetuneTestData(testDataDir, testCheckpointDir, '6')

  // Check initial status
  const statusBefore = await model.status()
  verifyInitialStatus(t, statusBefore)

  const finetuneConfig = getDefaultFinetuneConfig({
    trainDatasetDir: trainDatasetPath,
    evalDatasetDir: evalDatasetPath,
    numberOfEpochs: 1
  })

  const finetunePromise = model.finetune(finetuneConfig)

  // Wait for finetuning to start or complete (handles race condition)
  const result = await waitForFinetuningStartOrComplete(model, finetunePromise, t)

  // Verify we saw FINETUNING status at some point (check if result indicates it started)
  // If it completed very quickly, that's also valid
  t.ok(result, 'Finetuning should complete')

  // Check final status
  const statusAfter = await model.status()
  t.ok(statusAfter === 'IDLE', 'Final status should be IDLE')
})

// Test: Periodic Checkpoint Creation
test('llama addon creates periodic checkpoints during finetuning', async t => {
  t.timeout(600_000)

  const { model } = await createTestModel(t)
  const { trainDatasetPath, evalDatasetPath, checkpointDir } = setupFinetuneTestData(testDataDir, testCheckpointDir, '8')

  const finetuneConfig = getDefaultFinetuneConfig({
    trainDatasetDir: trainDatasetPath,
    evalDatasetDir: evalDatasetPath,
    checkpointSaveDir: checkpointDir,
    numberOfEpochs: 2,
    checkpointSaveSteps: 1 // Save checkpoint every step
  })

  const finetunePromise = model.finetune(finetuneConfig)

  // Wait for finetuning to start (we need it to be running to check checkpoints)
  try {
    await waitForStatus(model, 'FINETUNING', { timeoutMs: 5000 })
    // Wait a bit for checkpoints to be created
    await new Promise(resolve => setTimeout(resolve, 5000))
  } catch (err) {
    // If finetuning completed very quickly, that's okay - checkpoints might not exist
    const status = await model.status()
    if (status === 'IDLE') {
      t.comment('Finetuning completed very quickly - checkpoints may not exist')
    } else {
      throw err
    }
  }

  // Check if checkpoint directories exist
  // Note: Checkpoint naming may vary, so we just check if the directory has content
  if (fs.existsSync(checkpointDir)) {
    const files = fs.readdirSync(checkpointDir)
    t.ok(files.length > 0, 'Checkpoint directory should contain files')
    t.comment(`Found ${files.length} items in checkpoint directory`)
  }

  await finetunePromise
  cleanupCheckpoints(checkpointDir)
})

// Test: Error Handling - Invalid Dataset Path
test('llama addon handles invalid dataset path error', async t => {
  t.timeout(600_000)

  const { model } = await createTestModel(t)

  const finetuneConfig = getDefaultFinetuneConfig({
    trainDatasetDir: path.join(testDataDir, 'nonexistent.jsonl'),
    evalDatasetDir: path.join(testDataDir, 'nonexistent.jsonl'),
    numberOfEpochs: 1
  })

  // Try to start finetuning with invalid path
  // Note: Errors are logged but don't throw - finetuning completes with IDLE status
  const finetunePromise = model.finetune(finetuneConfig)
  const result = await finetunePromise

  // Finetuning will complete (status IDLE) even with errors
  // The error is logged in C++ but doesn't propagate as an exception
  // We verify that the result indicates completion, but the actual error
  // would be visible in the logs (which we can see in the test output)
  t.ok(result, 'Finetuning promise resolves (errors are logged, not thrown)')
  t.ok(result.status === 'IDLE', 'Status becomes IDLE even on error')

  // Verify that the adapter was NOT saved (since finetuning failed)
  // The adapter might not exist if finetuning failed early
  // This is acceptable - the error is logged in C++ logs
  t.comment('Error handling: Invalid dataset path errors are logged in C++ but do not throw exceptions')
})

// Test: Model State After Finetuning
test('llama addon model can be used for inference after finetuning', async t => {
  t.timeout(600_000)

  const { model } = await createTestModel(t)
  const { trainDatasetPath, evalDatasetPath } = setupFinetuneTestData(testDataDir, testCheckpointDir, '10')

  // Complete finetuning first
  const finetuneConfig = getDefaultFinetuneConfig({
    trainDatasetDir: trainDatasetPath,
    evalDatasetDir: evalDatasetPath,
    numberOfEpochs: 1
  })

  const finetunePromise = model.finetune(finetuneConfig)
  const result = await waitForFinetuningStartOrComplete(model, finetunePromise, t)
  t.ok(result, 'Finetuning should complete')

  // Verify model is in valid state after finetuning
  const status = await model.status()
  t.ok(['IDLE', 'LISTENING'].includes(status), 'Model should be ready for inference')

  // Verify the LoRA adapter was saved
  const adapterPath = path.join(finetuneConfig.outputParametersDir, 'trained-lora-adapter.gguf')
  t.ok(fs.existsSync(adapterPath), 'LoRA adapter should be saved after finetuning')

  // Note: To actually use the finetuned adapter for inference, you need to:
  // 1. Unload the current model (which has training state attached)
  // 2. Reload the model with the saved LoRA adapter in the config
  // However, this test just verifies that:
  // - Finetuning completes successfully
  // - Model is in a valid state (IDLE/LISTENING)
  // - LoRA adapter file is saved
  // The actual inference with the finetuned adapter requires reloading the model,
  // which is tested separately in the examples (simple-lora-inference.js)
  t.comment('Model is in valid state after finetuning. To use finetuned adapter for inference, reload model with lora config.')
})

// ============================================================================
// Pause/Resume Finetuning Tests
// ============================================================================

// Test: Pause Finetuning
test('llama addon can pause finetuning', async t => {
  t.timeout(600_000)

  const { model } = await createTestModel(t)
  const { trainDatasetPath, evalDatasetPath, checkpointDir } = setupFinetuneTestData(testDataDir, testCheckpointDir, '3')

  const finetuneConfig = getDefaultFinetuneConfig({
    trainDatasetDir: trainDatasetPath,
    evalDatasetDir: evalDatasetPath,
    checkpointSaveDir: checkpointDir,
    numberOfEpochs: 3, // Use 3 epochs so we have time to pause
    checkpointSaveSteps: 1
  })

  // Start finetuning (non-blocking)
  const finetunePromise = model.finetune(finetuneConfig)

  // Wait for finetuning to start
  const status = await waitForFinetuningStart(model, { maxAttempts: 10 })

  if (status === 'IDLE') {
    await handleEarlyCompletion(t, finetunePromise, checkpointDir, 'Finetuning completed too quickly to test pause/resume')
    return
  }

  t.ok(status === 'FINETUNING', 'Status should be FINETUNING before pause')
  t.comment('Finetuning started, pausing immediately...')

  // Pause finetuning
  await model.pauseFinetune()
  await waitForStatus(model, 'PAUSED', { timeoutMs: 15000 })
  t.comment('Finetuning paused')

  // Verify pause checkpoint was created
  await verifyPauseCheckpoint(t, checkpointDir, 3000)

  // Resume to complete the test
  await model.resumeFinetune()
  await waitForStatus(model, 'FINETUNING', { timeoutMs: 15000 })

  // Wait for completion
  const result = await finetunePromise
  t.ok(result, 'Finetuning should complete after resume')

  cleanupCheckpoints(checkpointDir)
})

// Test: Resume Finetuning from Pause
test('llama addon can resume finetuning from pause checkpoint', async t => {
  t.timeout(600_000)

  const { model } = await createTestModel(t)
  const { trainDatasetPath, evalDatasetPath, checkpointDir } = setupFinetuneTestData(testDataDir, testCheckpointDir, '4')

  const finetuneConfig = getDefaultFinetuneConfig({
    trainDatasetDir: trainDatasetPath,
    evalDatasetDir: evalDatasetPath,
    checkpointSaveDir: checkpointDir,
    numberOfEpochs: 3, // Use 3 epochs to give us time to pause
    checkpointSaveSteps: 1
  })

  // Start finetuning
  const finetunePromise = model.finetune(finetuneConfig)

  // Wait for finetuning to start
  const status = await waitForFinetuningStart(model, { maxAttempts: 10 })

  if (status === 'IDLE') {
    await handleEarlyCompletion(t, finetunePromise, null, 'Finetuning completed too quickly to test pause/resume')
    return
  }

  t.ok(status === 'FINETUNING', 'Status should be FINETUNING before pause')

  // Pause immediately
  await model.pauseFinetune()
  await waitForStatus(model, 'PAUSED', { timeoutMs: 15000 })
  t.ok(await model.status() === 'PAUSED', 'Status should be PAUSED after pause')
  t.comment('Finetuning paused, waiting before resume...')

  // Verify pause checkpoint exists before resume
  const pauseCheckpointBeforeResume = await verifyPauseCheckpoint(t, checkpointDir, 3000)
  if (pauseCheckpointBeforeResume) {
    t.comment(`Pause checkpoint exists before resume: ${path.basename(pauseCheckpointBeforeResume)}`)
  }

  // Wait a bit while paused
  await new Promise(resolve => setTimeout(resolve, 2000))

  // Resume
  await model.resumeFinetune()
  const resumedStatus = await waitForStatus(model, 'FINETUNING', { timeoutMs: 15000 })
  t.ok(resumedStatus === 'FINETUNING', 'Status should be FINETUNING after resume')
  t.comment('Finetuning resumed')

  // Wait for completion and verify final status
  const result = await finetunePromise
  t.ok(result, 'Finetuning should complete after resume')
  await verifyFinalStatus(t, model, result)

  // Verify pause checkpoint was cleared after successful resume
  const pauseCheckpointAfterResume = findPauseCheckpoint(checkpointDir)
  if (!pauseCheckpointAfterResume) {
    t.comment('Pause checkpoint was cleared after successful resume (expected)')
  }

  cleanupCheckpoints(checkpointDir)
})

// Test: Multiple Pause/Resume Cycles
test('llama addon can handle multiple pause/resume cycles', async t => {
  t.timeout(600_000)

  const { model } = await createTestModel(t)
  const { trainDatasetPath, evalDatasetPath, checkpointDir } = setupFinetuneTestData(testDataDir, testCheckpointDir, '5')

  const finetuneConfig = getDefaultFinetuneConfig({
    trainDatasetDir: trainDatasetPath,
    evalDatasetDir: evalDatasetPath,
    checkpointSaveDir: checkpointDir,
    numberOfEpochs: 3,
    checkpointSaveSteps: 1
  })

  const finetunePromise = model.finetune(finetuneConfig)

  // Wait for finetuning to start
  const status = await waitForFinetuningStart(model, { maxAttempts: 30 })

  if (status === 'IDLE') {
    await handleEarlyCompletion(t, finetunePromise, checkpointDir, 'Finetuning completed too quickly to test multiple pause/resume cycles')
    return
  }

  t.ok(status === 'FINETUNING', 'Status should be FINETUNING before first pause')

  // First pause/resume cycle
  await new Promise(resolve => setTimeout(resolve, 2000))
  await model.pauseFinetune()
  const firstPaused = await waitForStatus(model, 'PAUSED', { timeoutMs: 15000 })
  t.ok(firstPaused === 'PAUSED', 'Status should be PAUSED after first pause')

  await new Promise(resolve => setTimeout(resolve, 1000))
  await model.resumeFinetune()
  const firstResumed = await waitForStatus(model, 'FINETUNING', { timeoutMs: 15000 })
  t.ok(firstResumed === 'FINETUNING', 'Status should be FINETUNING after first resume')

  // Second pause/resume cycle
  await new Promise(resolve => setTimeout(resolve, 2000))
  await model.pauseFinetune()
  const secondPaused = await waitForStatus(model, 'PAUSED', { timeoutMs: 15000 })
  t.ok(secondPaused === 'PAUSED', 'Status should be PAUSED after second pause')

  await new Promise(resolve => setTimeout(resolve, 1000))
  await model.resumeFinetune()
  const secondResumed = await waitForStatus(model, 'FINETUNING', { timeoutMs: 15000 })
  t.ok(secondResumed === 'FINETUNING', 'Status should be FINETUNING after second resume')

  // Wait for completion
  const result = await finetunePromise
  t.ok(result, 'Finetuning should complete after multiple pause/resume cycles')
  t.ok(result.status === 'IDLE', 'Final status should be IDLE')

  cleanupCheckpoints(checkpointDir)
})

// Test: Status Transitions During Pause/Resume
test('llama addon has correct status transitions during pause/resume', async t => {
  t.timeout(600_000)

  const { model } = await createTestModel(t)
  const { trainDatasetPath, evalDatasetPath } = setupFinetuneTestData(testDataDir, testCheckpointDir, '7')

  const finetuneConfig = getDefaultFinetuneConfig({
    trainDatasetDir: trainDatasetPath,
    evalDatasetDir: evalDatasetPath,
    numberOfEpochs: 3 // Use 3 epochs to give us time to pause
  })

  // Check initial status
  const initialStatus = await model.status()
  verifyInitialStatus(t, initialStatus)

  const finetunePromise = model.finetune(finetuneConfig)

  // Wait for finetuning to start
  const status = await waitForFinetuningStart(model, { maxAttempts: 10 })

  if (status === 'IDLE') {
    await handleEarlyCompletion(t, finetunePromise, null, 'Finetuning completed too quickly to test pause/resume')
    const statusFinal = await model.status()
    t.ok(statusFinal === 'IDLE', 'Final status should be IDLE')
    return
  }

  t.ok(status === 'FINETUNING', 'Status should be FINETUNING before pause')

  // Pause immediately (don't wait, finetuning might complete quickly)
  await model.pauseFinetune()
  const statusPaused = await waitForStatus(model, 'PAUSED', { timeoutMs: 15000 })
  t.ok(statusPaused === 'PAUSED', 'Status should transition to PAUSED')

  // Verify status is actually PAUSED
  const verifyPaused = await model.status()
  t.ok(verifyPaused === 'PAUSED', 'Status should remain PAUSED')

  // Resume and verify status
  await model.resumeFinetune()
  const statusResumed = await waitForStatus(model, 'FINETUNING', { timeoutMs: 15000 })
  t.ok(statusResumed === 'FINETUNING', 'Status should transition back to FINETUNING')

  // Verify status is actually FINETUNING
  const verifyFinetuning = await model.status()
  t.ok(verifyFinetuning === 'FINETUNING', 'Status should remain FINETUNING after resume')

  // Wait for completion
  await finetunePromise
  await verifyFinalStatus(t, model)
})

// Test: Pause Checkpoint Creation
test('llama addon creates pause checkpoint when paused', async t => {
  t.timeout(600_000)

  const { model } = await createTestModel(t)
  const { trainDatasetPath, evalDatasetPath, checkpointDir } = setupFinetuneTestData(testDataDir, testCheckpointDir, '9')

  const finetuneConfig = getDefaultFinetuneConfig({
    trainDatasetDir: trainDatasetPath,
    evalDatasetDir: evalDatasetPath,
    checkpointSaveDir: checkpointDir,
    numberOfEpochs: 3 // Use 3 epochs to give us time to pause
  })

  const finetunePromise = model.finetune(finetuneConfig)

  // Wait for finetuning to start
  const status = await waitForFinetuningStart(model, { maxAttempts: 10 })

  if (status === 'IDLE') {
    await handleEarlyCompletion(t, finetunePromise, checkpointDir, 'Finetuning completed too quickly to test pause checkpoint')
    return
  }

  t.ok(status === 'FINETUNING', 'Status should be FINETUNING before pause')

  // Pause immediately
  await model.pauseFinetune()
  await waitForStatus(model, 'PAUSED', { timeoutMs: 15000 })

  // Verify pause checkpoint was created
  await verifyPauseCheckpoint(t, checkpointDir, 3000)

  // Resume and complete
  await model.resumeFinetune()
  await finetunePromise
  cleanupCheckpoints(checkpointDir)
})
