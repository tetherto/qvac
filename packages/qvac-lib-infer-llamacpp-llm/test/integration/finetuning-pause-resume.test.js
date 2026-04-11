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
const isMobile = platform === 'ios' || platform === 'android'
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
  },
  {
    id: 'medgemma-4b-it-q4_0',
    name: 'medgemma-4b-it-Q4_0.gguf',
    url: 'https://huggingface.co/unsloth/medgemma-4b-it-GGUF/resolve/main/medgemma-4b-it-Q4_0.gguf',
    skip: isMobile || forceCpuDevice || platform === 'darwin' || isWindows
  }
]

function waitForProgress (handle, minSteps = 2, timeoutMs = 300_000) {
  return new Promise((resolve, reject) => {
    let count = 0
    const timer = setTimeout(() => {
      handle.removeListener('stats', onStats)
      reject(new Error(`waitForProgress: no progress after ${timeoutMs}ms (received ${count}/${minSteps} steps)`))
    }, timeoutMs)
    const onStats = () => {
      if (++count >= minSteps) {
        clearTimeout(timer)
        handle.removeListener('stats', onStats)
        resolve()
      }
    }
    handle.on('stats', onStats)
  })
}

function assertFiniteMetricIfPresent (t, stats, key, modelId) {
  const value = stats?.[key]
  if (value == null || (typeof value === 'number' && isNaN(value))) return
  t.is(typeof value, 'number', `[${modelId}] ${key} should be a number when present`)
  t.ok(Number.isFinite(value), `[${modelId}] ${key} should be finite (not Inf), got: ${value}`)
}

function assertLossAndAccuracyAreFinite (t, result, modelId) {
  const stats = result?.stats
  if (!stats || typeof stats !== 'object') return
  assertFiniteMetricIfPresent(t, stats, 'train_loss', modelId)
  assertFiniteMetricIfPresent(t, stats, 'train_loss_uncertainty', modelId)
  assertFiniteMetricIfPresent(t, stats, 'val_loss', modelId)
  assertFiniteMetricIfPresent(t, stats, 'val_loss_uncertainty', modelId)
  assertFiniteMetricIfPresent(t, stats, 'train_accuracy', modelId)
  assertFiniteMetricIfPresent(t, stats, 'train_accuracy_uncertainty', modelId)
  assertFiniteMetricIfPresent(t, stats, 'val_accuracy', modelId)
  assertFiniteMetricIfPresent(t, stats, 'val_accuracy_uncertainty', modelId)
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
  for (const modelVariant of FINETUNE_MODELS) {
    if (modelVariant.skip) {
      t.comment(`[${modelVariant.id}] skipped on ${platform}-${arch}`)
      continue
    }
    const [modelName, modelDir] = await ensureModel({
      modelName: modelVariant.name,
      downloadUrl: modelVariant.url
    })

    const finetuneConfig = setupParams(modelDir, {
      checkpointSaveSteps: 10,
      datasetSize: isMobile ? 8 : 16
    })
    const checkpointDir = finetuneConfig.checkpointSaveDir

    const loader = new FilesystemDL({ dirPath: modelDir })
    const loggerHandle = attachSpecLogger({ forwardToConsole: true })

    const config = {
      gpu_layers: '999',
      ctx_size: '512',
      device: forceCpuDevice ? 'cpu' : 'gpu',
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
      config
    )

    try {
      await model.load()

      const finetuneHandle = await model.finetune(finetuneConfig)
      let progressCount = 0
      finetuneHandle.on('stats', stats => {
        progressCount++
        t.ok(!isNaN(stats.loss), `[${modelVariant.id}] progress loss must not be NaN (step ${stats.global_steps})`)
        t.ok(!isNaN(stats.accuracy), `[${modelVariant.id}] progress accuracy must not be NaN (step ${stats.global_steps})`)
        if (!isNaN(stats.loss_uncertainty)) t.ok(Number.isFinite(stats.loss_uncertainty), `[${modelVariant.id}] progress loss_uncertainty should be finite (step ${stats.global_steps})`)
        if (!isNaN(stats.accuracy_uncertainty)) t.ok(Number.isFinite(stats.accuracy_uncertainty), `[${modelVariant.id}] progress accuracy_uncertainty should be finite (step ${stats.global_steps})`)
        t.comment(`[${modelVariant.id}] progress: epoch=${stats.current_epoch + 1} step=${stats.global_steps} loss=${stats.loss?.toFixed(4)}±${stats.loss_uncertainty?.toFixed(4)} acc=${(stats.accuracy * 100)?.toFixed(1)}±${(stats.accuracy_uncertainty * 100)?.toFixed(1)}% backend_batch=${stats.current_batch}/${stats.total_batches}`)
      })
      await waitForProgress(finetuneHandle, 2)

      await model.pause()

      const pauseResult = await finetuneHandle.await()
      assertLossAndAccuracyAreFinite(t, pauseResult, modelVariant.id)
      if (pauseResult?.status === 'COMPLETED') {
        t.comment(`[${modelVariant.id}] Finetune result: ${JSON.stringify(pauseResult)}`)

        const expectedGlobalSteps = isMobile ? 6 : 12
        t.is(
          pauseResult.stats?.global_steps, expectedGlobalSteps,
          `[${modelVariant.id}] global_steps should be ${expectedGlobalSteps}, got ${pauseResult.stats?.global_steps}`
        )

        const earlyStats = pauseResult.stats
        t.ok(earlyStats?.train_loss != null, `[${modelVariant.id}] train_loss must not be null`)
        t.ok(earlyStats?.train_loss_uncertainty != null, `[${modelVariant.id}] train_loss_uncertainty must not be null`)
        t.ok(earlyStats?.train_accuracy != null, `[${modelVariant.id}] train_accuracy must not be null`)
        t.ok(earlyStats?.train_accuracy_uncertainty != null, `[${modelVariant.id}] train_accuracy_uncertainty must not be null`)
        t.ok(earlyStats?.val_loss != null, `[${modelVariant.id}] val_loss must not be null`)
        t.ok(earlyStats?.val_loss !== 0, `[${modelVariant.id}] val_loss must not be 0`)
        t.ok(earlyStats?.val_loss_uncertainty != null, `[${modelVariant.id}] val_loss_uncertainty must not be null`)
        t.ok(earlyStats?.val_accuracy != null, `[${modelVariant.id}] val_accuracy must not be null`)
        t.ok(earlyStats?.val_accuracy_uncertainty != null, `[${modelVariant.id}] val_accuracy_uncertainty must not be null`)

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

      verifyPauseCheckpoint(t, checkpointDir)

      const resumeHandle = await model.finetune(finetuneConfig)
      resumeHandle.on('stats', stats => {
        progressCount++
        t.ok(!isNaN(stats.loss), `[${modelVariant.id}] resume progress loss must not be NaN (step ${stats.global_steps})`)
        t.ok(!isNaN(stats.accuracy), `[${modelVariant.id}] resume progress accuracy must not be NaN (step ${stats.global_steps})`)
        if (!isNaN(stats.loss_uncertainty)) t.ok(Number.isFinite(stats.loss_uncertainty), `[${modelVariant.id}] resume progress loss_uncertainty should be finite (step ${stats.global_steps})`)
        if (!isNaN(stats.accuracy_uncertainty)) t.ok(Number.isFinite(stats.accuracy_uncertainty), `[${modelVariant.id}] resume progress accuracy_uncertainty should be finite (step ${stats.global_steps})`)
        t.comment(`[${modelVariant.id}] progress: epoch=${stats.current_epoch + 1} step=${stats.global_steps} loss=${stats.loss?.toFixed(4)}±${stats.loss_uncertainty?.toFixed(4)} acc=${(stats.accuracy * 100)?.toFixed(1)}±${(stats.accuracy_uncertainty * 100)?.toFixed(1)}% backend_batch=${stats.current_batch}/${stats.total_batches}`)
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
      const expectedGlobalSteps = isMobile ? 6 : 12
      t.is(
        result.stats?.global_steps, expectedGlobalSteps,
        `[${modelVariant.id}] global_steps should be ${expectedGlobalSteps}, got ${result.stats?.global_steps}`
      )

      const stats = result.stats
      t.ok(stats, `[${modelVariant.id}] Terminal result must include stats`)
      t.ok(!isNaN(stats.train_loss) && stats.train_loss > 0, `[${modelVariant.id}] train_loss must be a positive number`)
      t.ok(stats.train_loss_uncertainty != null, `[${modelVariant.id}] train_loss_uncertainty must not be null`)
      t.ok(!isNaN(stats.train_accuracy) && stats.train_accuracy >= 0, `[${modelVariant.id}] train_accuracy must not be NaN`)
      t.ok(stats.train_accuracy_uncertainty != null, `[${modelVariant.id}] train_accuracy_uncertainty must not be null`)
      t.ok(stats.val_loss != null, `[${modelVariant.id}] val_loss must not be null`)
      t.ok(!isNaN(stats.val_loss), `[${modelVariant.id}] val_loss must not be NaN`)
      t.ok(stats.val_loss !== 0, `[${modelVariant.id}] val_loss must not be 0`)
      t.ok(stats.val_loss_uncertainty != null, `[${modelVariant.id}] val_loss_uncertainty must not be null`)
      t.ok(stats.val_accuracy != null, `[${modelVariant.id}] val_accuracy must not be null`)
      t.ok(!isNaN(stats.val_accuracy), `[${modelVariant.id}] val_accuracy must not be NaN`)
      t.ok(stats.val_accuracy_uncertainty != null, `[${modelVariant.id}] val_accuracy_uncertainty must not be null`)

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

  const finetuneConfig = setupParams(modelDir, { checkpointSaveSteps: 5, datasetSize: isMobile ? 8 : 16, testId: 'cancel-test' })
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
      verbosity: '2'
    }
  )

  const fs = require('bare-fs')

  try {
    await model.load()

    const finetuneHandle = await model.finetune(finetuneConfig)
    await waitForProgress(finetuneHandle, 2)

    await model.cancel()
    const result = await finetuneHandle.await()
    t.comment(`Cancel result: ${JSON.stringify(result)}`)

    t.ok(result, 'cancel() must return a result')
    t.ok(
      result.status === 'PAUSED' || result.status === 'COMPLETED',
      `cancel() resolves with PAUSED or COMPLETED, got: ${result.status}`
    )

    if (result.status === 'COMPLETED') {
      const expectedGlobalSteps = isMobile ? 6 : 12
      t.is(
        result.stats?.global_steps, expectedGlobalSteps,
        `global_steps should be ${expectedGlobalSteps}, got ${result.stats?.global_steps}`
      )
    }

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

test('inference with session cache works after finetuning', { timeout: PAUSE_RESUME_TIMEOUT_MS, skip: skipFinetuning }, async t => {
  const modelVariant = FINETUNE_MODELS[0]
  const [modelName, modelDir] = await ensureModel({
    modelName: modelVariant.name,
    downloadUrl: modelVariant.url
  })

  const finetuneConfig = setupParams(modelDir, { checkpointSaveSteps: 5, datasetSize: isMobile ? 8 : 16 })
  const checkpointDir = finetuneConfig.checkpointSaveDir
  const sessionFile = path.join(modelDir, 'test-session-finetune.bin')

  const loader = new FilesystemDL({ dirPath: modelDir })
  const loggerHandle = attachSpecLogger({ forwardToConsole: true })

  const config = {
    gpu_layers: '999',
    ctx_size: '512',
    device: forceCpuDevice ? 'cpu' : 'gpu',
    verbosity: '2',
    n_predict: '64',
    seed: '42'
  }

  const model = new LlmLlamacpp(
    {
      loader,
      modelName,
      diskPath: modelDir,
      logger: console,
      opts: { stats: true }
    },
    config
  )

  const fs = require('bare-fs')

  try {
    await model.load()

    const sessionPrompt = [
      { role: 'user', content: 'What is 1+2? Answer with a number. /no_think' }
    ]
    const preResponse = await model.run(sessionPrompt, { cacheKey: sessionFile })
    let preOutput = ''
    await preResponse.onUpdate(token => { preOutput += token }).await()
    t.ok(preOutput.length > 0, 'Pre-finetune inference with session should produce output')
    t.comment(`Pre-finetune output: ${preOutput}`)

    const finetuneHandle = await model.finetune(finetuneConfig)
    const result = await finetuneHandle.await()
    t.ok(result, 'Finetune should return a result')
    t.comment(`Finetune result: ${JSON.stringify(result)}`)

    const expectedGlobalSteps = isMobile ? 6 : 12
    t.is(
      result.stats?.global_steps, expectedGlobalSteps,
      `global_steps should be ${expectedGlobalSteps}, got ${result.stats?.global_steps}`
    )

    const postPrompt = [
      { role: 'user', content: 'What is the output of the previous computation? answer with a number. /no_think' }
    ]
    const postResponse = await model.run(postPrompt, { cacheKey: sessionFile })
    let postOutput = ''
    await postResponse.onUpdate(token => { postOutput += token }).await()
    t.ok(postOutput.length > 0, 'Post-finetune inference with session should produce output')
    t.ok(postOutput.includes('3'), 'Post-finetune output should include the output of the previous computation')
    t.comment(`Post-finetune output: ${postOutput}`)

    t.pass('Inference with session cache works after finetuning')
  } finally {
    loggerHandle.release()
    await model.unload().catch(() => {})
    await loader.close().catch(() => {})
    cleanupCheckpoints(checkpointDir)
    try { fs.unlinkSync(sessionFile) } catch (_) {}
  }
})

test('microBatchSize override changes backend batch geometry', { timeout: PAUSE_RESUME_TIMEOUT_MS, skip: skipFinetuning }, async t => {
  const modelVariant = FINETUNE_MODELS[0]
  const [modelName, modelDir] = await ensureModel({
    modelName: modelVariant.name,
    downloadUrl: modelVariant.url
  })

  async function getTotalBatches (batchSize, microBatchSize, testId) {
    const config = setupParams(modelDir, { batchSize, microBatchSize, checkpointSaveSteps: 0, testId })
    const loader = new FilesystemDL({ dirPath: modelDir })
    const model = new LlmLlamacpp(
      { loader, modelName, diskPath: modelDir, logger: console, opts: { stats: true } },
      { gpu_layers: '999', ctx_size: '512', device: forceCpuDevice ? 'cpu' : 'gpu', verbosity: '0' }
    )
    try {
      await model.load()
      const handle = await model.finetune(config)
      let totalBatches = null
      handle.on('stats', stats => { if (totalBatches === null) totalBatches = stats.total_batches })
      await handle.await()
      return totalBatches
    } finally {
      await model.unload().catch(() => {})
      await loader.close().catch(() => {})
      cleanupCheckpoints(config.checkpointSaveDir)
    }
  }

  const largeMicro = await getTotalBatches(128, 128, 'batch-large')
  const smallMicro = await getTotalBatches(32, 8, 'batch-small')

  t.ok(largeMicro > 0, `total_batches with microBatch=128 should be positive (got ${largeMicro})`)
  t.ok(smallMicro > 0, `total_batches with microBatch=8 should be positive (got ${smallMicro})`)
  t.ok(smallMicro > largeMicro, `smaller microBatchSize should produce more total_batches (${smallMicro} > ${largeMicro})`)
  t.comment(`total_batches: microBatch=128 -> ${largeMicro}, microBatch=8 -> ${smallMicro}`)
})
