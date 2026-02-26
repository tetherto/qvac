'use strict'

const test = require('brittle')
const FilesystemDL = require('@qvac/dl-filesystem')
const LlmLlamacpp = require('../../index.js')
const {
  ensureModel,
  setupParams,
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
const isWindows = platform === 'win32'
const noGpu = proc.env && proc.env.NO_GPU === 'true'
const useCpu = isDarwinX64 || isLinuxArm64
const forceCpuDevice = useCpu || isWindows || noGpu
const skipFinetuning = useCpu || (noGpu && !isWindows)

const PAUSE_RESUME_TIMEOUT_MS = 1800_000

const FINETUNE_MODELS = [
  {
    id: 'qwen3-0.6b-q8_0',
    name: 'Qwen3-0.6B-Q8_0.gguf',
    url: 'https://huggingface.co/unsloth/Qwen3-0.6B-GGUF/resolve/main/Qwen3-0.6B-Q8_0.gguf'
  },
  {
    id: 'bitnet-b1_58-large-tq2_0',
    name: 'bitnet_b1_58-large-TQ2_0.gguf',
    url: 'https://huggingface.co/gianni-cor/bitnet_b1_58-large-TQ2_0/resolve/main/bitnet_b1_58-large-TQ2_0.gguf'
  }
]

function sleep (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

test('finetuning pause and resume', { timeout: PAUSE_RESUME_TIMEOUT_MS, skip: skipFinetuning }, async t => {
  const modelsToRun = FINETUNE_MODELS.filter(modelVariant => modelVariant.id === 'qwen3-0.6b-q8_0')

  for (const modelVariant of modelsToRun) {
    if (modelVariant.skipOnDarwin && platform === 'darwin') {
      t.comment(`[${modelVariant.id}] skipped on macOS (Metal does not support TQ2_0)`)
      continue
    }
    const [modelName, modelDir] = await ensureModel({
      modelName: modelVariant.name,
      downloadUrl: modelVariant.url
    })

    const finetuneConfig = setupParams(modelDir, {
      checkpointSaveSteps: 10
    })
    const checkpointDir = finetuneConfig.checkpointSaveDir

    const loader = new FilesystemDL({ dirPath: modelDir })
    const loggerHandle = attachSpecLogger({ forwardToConsole: true })

    const config = {
      gpu_layers: '999',
      ctx_size: '512',
      device: forceCpuDevice ? 'cpu' : 'gpu',
      flash_attn: 'off',
      verbosity: '2'
    }

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

    try {
      await model.load()

      const finetuneHandle = await model.finetune(finetuneConfig)
      await sleep(15000)

      await model.cancel()

      const pauseResult = await finetuneHandle.await()
      if (pauseResult?.status === 'COMPLETED') {
        await handleEarlyCompletion(
          t,
          finetuneHandle,
          checkpointDir,
          `[${modelVariant.id}] Finetuning completed too quickly`
        )
        continue
      }

      await verifyPauseCheckpoint(t, checkpointDir, 2000)

      const resumeHandle = await model.finetune()
      const result = await resumeHandle.await()

      t.ok(result, `[${modelVariant.id}] Resume must return result`)
      await verifyFinalStatus(t, model, result)
      t.pass(`[${modelVariant.id}] finetuning pause and resume completed`)
    } finally {
      loggerHandle.release()
      await model.unload().catch(() => {})
      await loader.close().catch(() => {})
      cleanupCheckpoints(checkpointDir)
    }
  }
})
