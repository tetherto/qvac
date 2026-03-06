'use strict'

const test = require('brittle')
const path = require('bare-path')
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
const forceCpuDevice = useCpu || noGpu
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

function assertFiniteMetricIfPresent (t, stats, key, modelId) {
  const value = stats?.[key]
  if (value === undefined) return
  t.is(typeof value, 'number', `[${modelId}] ${key} should be a number when present`)
  t.ok(Number.isFinite(value), `[${modelId}] ${key} should be finite (not NaN/Inf), got: ${value}`)
}

function assertLossAndAccuracyAreFinite (t, result, modelId) {
  const stats = result?.stats
  if (!stats || typeof stats !== 'object') return
  assertFiniteMetricIfPresent(t, stats, 'train_loss', modelId)
  assertFiniteMetricIfPresent(t, stats, 'val_loss', modelId)
  assertFiniteMetricIfPresent(t, stats, 'train_accuracy', modelId)
  assertFiniteMetricIfPresent(t, stats, 'val_accuracy', modelId)
}

async function runLoraInference (t, modelVariant, modelName, modelDir, loraAdapterPath) {
  t.comment(`[${modelVariant.id}] Running inference with LoRA adapter: ${loraAdapterPath}`)

  const inferLoader = new FilesystemDL({ dirPath: modelDir })
  const inferConfig = {
    gpu_layers: '999',
    ctx_size: '512',
    device: forceCpuDevice ? 'cpu' : 'gpu',
    predict: '32',
    lora: loraAdapterPath
  }

  const inferModel = new LlmLlamacpp(
    {
      loader: inferLoader,
      modelName,
      diskPath: modelDir,
      logger: console,
      opts: { stats: true }
    },
    inferConfig
  )

  try {
    await inferModel.load()
    const prompt = [
      { role: 'user', content: 'Hello' }
    ]
    const response = await inferModel.run(prompt)
    let generated = ''
    await response.onUpdate(token => { generated += token }).await()
    t.ok(generated.length > 0, `[${modelVariant.id}] LoRA inference should produce output`)
    t.comment(`[${modelVariant.id}] LoRA inference output (${generated.length} chars): ${generated.slice(0, 100)}`)
    t.comment(`[${modelVariant.id}] LoRA inference stats: ${JSON.stringify(response.stats)}`)
  } finally {
    await inferModel.unload().catch(() => {})
    await inferLoader.close().catch(() => {})
  }
}

test('finetuning pause and resume', { timeout: PAUSE_RESUME_TIMEOUT_MS, skip: skipFinetuning }, async t => {
  const modelsToRun = isWindows
    ? FINETUNE_MODELS.filter(modelVariant => modelVariant.id === 'bitnet-b1_58-large-tq2_0')
    : FINETUNE_MODELS

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
      let progressCount = 0
      finetuneHandle.on('stats', stats => {
        progressCount++
        t.ok(!isNaN(stats.loss), `[${modelVariant.id}] progress loss must not be NaN (batch ${stats.current_batch})`)
        t.ok(!isNaN(stats.accuracy), `[${modelVariant.id}] progress accuracy must not be NaN (batch ${stats.current_batch})`)
        t.comment(`[${modelVariant.id}] progress: data=${stats.current_batch}/${stats.total_batches} loss=${stats.loss?.toFixed(4)} acc=${(stats.accuracy * 100)?.toFixed(1)}%`)
      })
      await sleep(15000)

      await model.pause()

      const pauseResult = await finetuneHandle.await()
      assertLossAndAccuracyAreFinite(t, pauseResult, modelVariant.id)
      if (pauseResult?.status === 'COMPLETED') {
        t.comment(`[${modelVariant.id}] Finetune result: ${JSON.stringify(pauseResult)}`)
        await handleEarlyCompletion(
          t,
          finetuneHandle,
          checkpointDir,
          `[${modelVariant.id}] Finetuning completed too quickly`
        )

        await model.unload().catch(() => {})
        await loader.close().catch(() => {})

        const loraAdapterPath = path.join(finetuneConfig.outputParametersDir, 'trained-lora-adapter.gguf')
        await runLoraInference(t, modelVariant, modelName, modelDir, loraAdapterPath)
        t.pass(`[${modelVariant.id}] finetuning (early) + LoRA inference completed`)
        continue
      }

      await verifyPauseCheckpoint(t, checkpointDir, 2000)

      const resumeHandle = await model.finetune()
      resumeHandle.on('stats', stats => {
        progressCount++
        t.ok(!isNaN(stats.loss), `[${modelVariant.id}] resume progress loss must not be NaN (batch ${stats.current_batch})`)
        t.ok(!isNaN(stats.accuracy), `[${modelVariant.id}] resume progress accuracy must not be NaN (batch ${stats.current_batch})`)
        t.comment(`[${modelVariant.id}] progress: data=${stats.current_batch}/${stats.total_batches} loss=${stats.loss?.toFixed(4)} acc=${(stats.accuracy * 100)?.toFixed(1)}%`)
      })
      const result = await resumeHandle.await()

      t.ok(result, `[${modelVariant.id}] Resume must return result`)
      t.ok(progressCount > 0, `[${modelVariant.id}] Must have received at least one progress stats event`)
      t.comment(`[${modelVariant.id}] Finetune result: ${JSON.stringify(result)}`)
      t.ok(
        result && typeof result.stats === 'object' && result.stats !== null,
        `[${modelVariant.id}] Finetune terminal result should include stats when opts.stats is enabled`
      )
      t.is(
        typeof result?.stats?.global_steps,
        'number',
        `[${modelVariant.id}] Finetune stats.global_steps should be a number`
      )
      t.is(
        typeof result?.stats?.epochs_completed,
        'number',
        `[${modelVariant.id}] Finetune stats.epochs_completed should be a number`
      )
      const stats = result.stats
      t.ok(stats, `[${modelVariant.id}] Terminal result must include stats`)
      t.ok(!isNaN(stats.train_loss) && stats.train_loss > 0, `[${modelVariant.id}] train_loss must be a positive number`)
      t.ok(!isNaN(stats.train_accuracy) && stats.train_accuracy >= 0, `[${modelVariant.id}] train_accuracy must not be NaN`)
      t.ok(!isNaN(stats.val_loss), `[${modelVariant.id}] val_loss must not be NaN`)
      t.ok(!isNaN(stats.val_accuracy), `[${modelVariant.id}] val_accuracy must not be NaN`)

      assertLossAndAccuracyAreFinite(t, result, modelVariant.id)
      t.comment(`[${modelVariant.id}] Finetune terminal stats: ${JSON.stringify(result.stats)}`)
      await verifyFinalStatus(t, model, result)
      t.pass(`[${modelVariant.id}] finetuning pause and resume completed`)

      await model.unload().catch(() => {})
      await loader.close().catch(() => {})

      const loraAdapterPath = path.join(finetuneConfig.outputParametersDir, 'trained-lora-adapter.gguf')
      await runLoraInference(t, modelVariant, modelName, modelDir, loraAdapterPath)
      t.pass(`[${modelVariant.id}] finetuning + LoRA inference completed`)
    } finally {
      loggerHandle.release()
      await model.unload().catch(() => {})
      await loader.close().catch(() => {})
      cleanupCheckpoints(checkpointDir)
    }
  }
})

test('cancel() stops finetuning and removes pause checkpoint', { timeout: PAUSE_RESUME_TIMEOUT_MS, skip: skipFinetuning }, async t => {
  const modelVariant = FINETUNE_MODELS[0]
  const [modelName, modelDir] = await ensureModel({
    modelName: modelVariant.name,
    downloadUrl: modelVariant.url
  })

  const finetuneConfig = setupParams(modelDir, { checkpointSaveSteps: 5 })
  const checkpointDir = finetuneConfig.checkpointSaveDir

  const loader = new FilesystemDL({ dirPath: modelDir })
  const loggerHandle = attachSpecLogger({ forwardToConsole: true })

  const model = new LlmLlamacpp(
    {
      loader,
      modelName,
      diskPath: modelDir,
      logger: console,
      opts: { stats: true }
    },
    {
      gpu_layers: '999',
      ctx_size: '512',
      device: forceCpuDevice ? 'cpu' : 'gpu',
      flash_attn: 'off',
      verbosity: '2'
    },
    finetuneConfig
  )

  const fs = require('bare-fs')

  try {
    await model.load()

    const finetuneHandle = await model.finetune(finetuneConfig)
    await sleep(15000)

    await model.cancel()
    const result = await finetuneHandle.await()
    t.comment(`Cancel result: ${JSON.stringify(result)}`)

    t.ok(result, 'cancel() must return a result')
    t.ok(
      result.status === 'PAUSED' || result.status === 'COMPLETED',
      `cancel() resolves with PAUSED or COMPLETED, got: ${result.status}`
    )

    const hasPauseCheckpoint = fs.existsSync(checkpointDir) &&
      fs.readdirSync(checkpointDir).some(f => f.startsWith('pause_checkpoint_step_'))
    t.ok(!hasPauseCheckpoint, 'cancel() must remove pause checkpoint so next finetune() starts fresh')

    t.pass('cancel() stops finetuning and clears checkpoint')
  } finally {
    loggerHandle.release()
    await model.unload().catch(() => {})
    await loader.close().catch(() => {})
    cleanupCheckpoints(checkpointDir)
  }
})

// Regression: pause during validation of the final epoch writes
// epoch = currentEpoch + 1 in checkpoint metadata, causing the resume
// training loop to be skipped entirely.  Stats must still be populated.
test('resume after final-epoch validation pause returns stats', { timeout: PAUSE_RESUME_TIMEOUT_MS, skip: skipFinetuning }, async t => {
  const modelVariant = FINETUNE_MODELS[0]
  const [modelName, modelDir] = await ensureModel({
    modelName: modelVariant.name,
    downloadUrl: modelVariant.url
  })

  const finetuneConfig = setupParams(modelDir, { checkpointSaveSteps: 5 })
  const checkpointDir = finetuneConfig.checkpointSaveDir

  const loader = new FilesystemDL({ dirPath: modelDir })
  const loggerHandle = attachSpecLogger({ forwardToConsole: true })

  const model = new LlmLlamacpp(
    {
      loader,
      modelName,
      diskPath: modelDir,
      logger: console,
      opts: { stats: true }
    },
    {
      gpu_layers: '999',
      ctx_size: '512',
      device: forceCpuDevice ? 'cpu' : 'gpu',
      flash_attn: 'off',
      verbosity: '2'
    },
    finetuneConfig
  )

  try {
    await model.load()

    const finetuneHandle = await model.finetune(finetuneConfig)
    await sleep(20000)

    await model.pause()

    const pauseResult = await finetuneHandle.await()
    t.comment(`Initial finetune result: ${JSON.stringify(pauseResult)}`)

    const assertStats = (res, label) => {
      t.ok(res?.stats?.global_steps >= 1, `[${label}] stats.global_steps >= 1`)
      t.ok(res?.stats?.epochs_completed >= 1, `[${label}] stats.epochs_completed >= 1`)
    }

    if (pauseResult?.status === 'COMPLETED') {
      assertStats(pauseResult, 'completed')
      return
    }

    t.is(pauseResult?.status, 'PAUSED', 'Initial finetune should be paused')
    await verifyPauseCheckpoint(t, checkpointDir, 2000)

    const result = await (await model.finetune()).await()
    t.comment(`Resume result: ${JSON.stringify(result)}`)
    assertStats(result, 'resumed')
  } finally {
    loggerHandle.release()
    await model.unload().catch(() => {})
    await loader.close().catch(() => {})
    cleanupCheckpoints(checkpointDir)
  }
})
