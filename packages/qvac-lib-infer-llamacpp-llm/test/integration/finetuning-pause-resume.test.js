'use strict'

const test = require('brittle')
const FilesystemDL = require('@qvac/dl-filesystem')
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
const proc = require('bare-process')

const platform = os.platform()
const arch = os.arch()
const isDarwinX64 = platform === 'darwin' && arch === 'x64'
const isLinuxArm64 = platform === 'linux' && arch === 'arm64'
const noGpu = proc.env && proc.env.NO_GPU === 'true'
const useCpu = isDarwinX64 || isLinuxArm64

const PAUSE_RESUME_TIMEOUT_MS = 1200_000

const FINETUNE_MODEL = {
  name: 'Qwen3-0.6B-Q8_0.gguf',
  url: 'https://huggingface.co/unsloth/Qwen3-0.6B-GGUF/resolve/main/Qwen3-0.6B-Q8_0.gguf'
}


test('finetuning pause and resume', { timeout: PAUSE_RESUME_TIMEOUT_MS, skip: isDarwinX64 || noGpu }, async t => {
  const [modelName, modelDir] = await ensureModel({
    modelName: FINETUNE_MODEL.name,
    downloadUrl: FINETUNE_MODEL.url
  })

  const { trainDatasetPath, evalDatasetPath, checkpointDir } = setupPauseResumeTestData(
    modelDir,
    modelDir,
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
    checkpointSaveSteps: 2,
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
  await model.cancel()

  const pauseResult = await finetuneHandle.await()
  if (pauseResult?.status === 'COMPLETED') {
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
