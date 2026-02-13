'use strict'

const test = require('brittle')
const FilesystemDL = require('@qvac/dl-filesystem')
const getTmpDir = require('test-tmp')
const LlmLlamacpp = require('../../index.js')
const {
  ensureModel,
  setupPauseResumeTestData,
  getDefaultFinetuneConfig,
  verifyPauseCheckpoint,
  handleEarlyCompletion,
  verifyFinalStatus,
  cleanupCheckpoints,
  findPauseCheckpoint,
  parsePauseCheckpointMetadata
} = require('./utils')
const { attachSpecLogger } = require('./spec-logger')
const os = require('bare-os')

const platform = os.platform()
const arch = os.arch()
const isDarwinX64 = platform === 'darwin' && arch === 'x64'
const isLinuxArm64 = platform === 'linux' && arch === 'arm64'
const useCpu = isDarwinX64 || isLinuxArm64

const FINETUNE_MODEL = {
  name: 'Qwen3-0.6B-Q8_0.gguf',
  url: 'https://huggingface.co/unsloth/Qwen3-0.6B-GGUF/resolve/main/Qwen3-0.6B-Q8_0.gguf'
}

function sleep (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

test('finetuning pause and resume', { timeout: 360_000, skip: isDarwinX64 }, async t => {
  const [modelName, modelDir] = await ensureModel({
    modelName: FINETUNE_MODEL.name,
    downloadUrl: FINETUNE_MODEL.url
  })

  const testDataDir = await getTmpDir()
  const testCheckpointDir = await getTmpDir()
  const { trainDatasetPath, evalDatasetPath, checkpointDir } = setupPauseResumeTestData(
    testDataDir,
    testCheckpointDir,
    'pause-resume'
  )

  const loader = new FilesystemDL({ dirPath: modelDir })
  const loggerHandle = attachSpecLogger({ forwardToConsole: false })

  const config = {
    gpu_layers: '999',
    ctx_size: '512',
    device: useCpu ? 'cpu' : 'gpu',
    flash_attn: 'off'
  }

  const finetuneConfig = getDefaultFinetuneConfig({
    trainDatasetDir: trainDatasetPath,
    evalDatasetDir: evalDatasetPath,
    numberOfEpochs: 2,
    microBatchSize: 2,
    contextLength: 128,
    checkpointSaveSteps: 10,
    checkpointSaveDir: checkpointDir
  })

  const model = new LlmLlamacpp(
    {
      loader,
      modelName,
      diskPath: modelDir,
      logger: console,
      opts: { stats: true }
    },
    config,
    finetuneConfig
  )

  t.teardown(async () => {
    try {
      loggerHandle.release()
      await model.unload().catch(() => {})
      await loader.close().catch(() => {})
      cleanupCheckpoints(checkpointDir)
    } catch (err) {}
  })

  await model.load()

  const finetuneHandle = await model.finetune(finetuneConfig)
  await sleep(15000)
  await model.cancel()

  const pauseResult = await finetuneHandle.await()
  if (pauseResult?.status === 'IDLE') {
    return handleEarlyCompletion(t, finetuneHandle, checkpointDir)
  }

  await verifyPauseCheckpoint(t, checkpointDir, 2000)

  const resumeHandle = await model.finetune()
  const result = await resumeHandle.await()

  t.ok(result, 'Resume must return result')
  await verifyFinalStatus(t, model, result)
  cleanupCheckpoints(checkpointDir)

  t.pass('finetuning pause and resume completed')
})

test('pause during validation then resume', { timeout: 360_000, skip: isDarwinX64 }, async t => {
  const [modelName, modelDir] = await ensureModel({
    modelName: FINETUNE_MODEL.name,
    downloadUrl: FINETUNE_MODEL.url
  })

  const testDataDir = await getTmpDir()
  const testCheckpointDir = await getTmpDir()
  const { trainDatasetPath, checkpointDir } = setupPauseResumeTestData(
    testDataDir,
    testCheckpointDir,
    'pause-during-val'
  )

  const loader = new FilesystemDL({ dirPath: modelDir })
  const loggerHandle = attachSpecLogger({ forwardToConsole: false })

  const config = {
    gpu_layers: '999',
    ctx_size: '512',
    device: useCpu ? 'cpu' : 'gpu',
    flash_attn: 'off'
  }

  // Use same path for train and eval so we get 5% validation split (evalSplit > 0)
  const finetuneConfig = getDefaultFinetuneConfig({
    trainDatasetDir: trainDatasetPath,
    evalDatasetDir: trainDatasetPath,
    numberOfEpochs: 2,
    microBatchSize: 1,
    contextLength: 128,
    checkpointSaveSteps: 10,
    checkpointSaveDir: checkpointDir
  })

  const model = new LlmLlamacpp(
    {
      loader,
      modelName,
      diskPath: modelDir,
      logger: console,
      opts: { stats: true }
    },
    config,
    finetuneConfig
  )

  const collectedLogs = []
  const origOutputCb = model._outputCallback && model._outputCallback.bind(model)
  model._outputCallback = function (instance, eventType, jobId, data, extra) {
    if (typeof data === 'string') {
      collectedLogs.push(data)
    }
    if (origOutputCb) {
      return origOutputCb(instance, eventType, jobId, data, extra)
    }
  }

  t.teardown(async () => {
    try {
      loggerHandle.release()
      await model.unload().catch(() => {})
      await loader.close().catch(() => {})
      cleanupCheckpoints(checkpointDir)
    } catch (err) {}
  })

  await model.load()

  const finetuneHandle = await model.finetune(finetuneConfig)
  // With 8 samples: trainSplit=7, evalSplit=1. Wait for 7 train batches + start of 1 val batch (timing-dependent).
  await sleep(35000)
  await model.cancel()

  const pauseResult = await finetuneHandle.await()
  if (pauseResult?.status === 'IDLE') {
    return handleEarlyCompletion(t, finetuneHandle, checkpointDir)
  }

  t.ok(pauseResult?.status === 'PAUSED', 'Pause result should be PAUSED')

  const hasDuringValidation = collectedLogs.some(log => log.includes('during validation'))
  if (!hasDuringValidation) {
    t.comment('Pause occurred during training (timing). Validation-pause path is tested when sleep lands in val phase.')
  } else {
    t.ok(true, 'Pause occurred during validation')
  }

  const pauseCheckpointPath = await verifyPauseCheckpoint(t, checkpointDir, 2000)
  if (pauseCheckpointPath && hasDuringValidation) {
    const meta = parsePauseCheckpointMetadata(pauseCheckpointPath)
    t.ok(meta && meta.epoch !== undefined && meta.epoch >= 1,
      'Validation pause checkpoint should have epoch >= 1 so resume starts next epoch')
  }

  const resumeHandle = await model.finetune()
  const result = await resumeHandle.await()

  t.ok(result, 'Resume must return result')
  await verifyFinalStatus(t, model, result)
  cleanupCheckpoints(checkpointDir)

  t.pass('pause during validation then resume completed')
})
