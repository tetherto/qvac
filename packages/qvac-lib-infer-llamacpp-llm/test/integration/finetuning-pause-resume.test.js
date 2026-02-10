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
  cleanupCheckpoints
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
  await model.pauseFinetune()

  const pauseResult = await finetuneHandle.await()
  if (pauseResult?.status === 'IDLE') {
    return handleEarlyCompletion(t, finetuneHandle, checkpointDir)
  }

  await verifyPauseCheckpoint(t, checkpointDir, 2000)

  const resumeHandle = await model.finetune({ resume: true })
  const result = await resumeHandle.await()

  t.ok(result, 'Resume must return result')
  await verifyFinalStatus(t, model, result)
  cleanupCheckpoints(checkpointDir)

  t.pass('finetuning pause and resume completed')
})
