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

function sleep (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
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

function ts () { return new Date().toISOString() }

async function runLoraInference (t, modelVariant, modelName, modelDir, loraAdapterPath) {
  const tag = `[${modelVariant.id}][LoraInfer]`
  t.comment(`${tag} ${ts()} START loraAdapterPath=${loraAdapterPath}`)

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
    t.comment(`${tag} ${ts()} loading model`)
    await inferModel.load()
    t.comment(`${tag} ${ts()} model loaded, starting inference`)
    const prompt = [
      { role: 'user', content: 'Hello' }
    ]
    const response = await inferModel.run(prompt)
    t.comment(`${tag} ${ts()} run() returned, awaiting output`)
    let generated = ''
    await response.onUpdate(token => { generated += token }).await()
    t.comment(`${tag} ${ts()} inference done, generated ${generated.length} chars`)
    t.ok(generated.length > 0, `[${modelVariant.id}] LoRA inference should produce output`)
    t.comment(`[${modelVariant.id}] LoRA inference output (${generated.length} chars): ${generated.slice(0, 100)}`)
    t.comment(`[${modelVariant.id}] LoRA inference stats: ${JSON.stringify(response.stats)}`)
  } finally {
    t.comment(`${tag} ${ts()} unloading inferModel`)
    await inferModel.unload().catch(() => {})
    t.comment(`${tag} ${ts()} closing inferLoader`)
    await inferLoader.close().catch(() => {})
    t.comment(`${tag} ${ts()} END`)
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
      config,
      finetuneConfig
    )

    const tag = `[${modelVariant.id}][Flow]`
    try {
      t.comment(`${tag} ${ts()} model.load() START`)
      await model.load()
      t.comment(`${tag} ${ts()} model.load() DONE`)

      t.comment(`${tag} ${ts()} model.finetune() START`)
      const finetuneHandle = await model.finetune(finetuneConfig)
      t.comment(`${tag} ${ts()} model.finetune() returned handle, responseStatus=${finetuneHandle.getStatus()}`)
      let progressCount = 0
      finetuneHandle.on('stats', stats => {
        progressCount++
        t.ok(!isNaN(stats.loss), `[${modelVariant.id}] progress loss must not be NaN (step ${stats.global_steps})`)
        t.ok(!isNaN(stats.accuracy), `[${modelVariant.id}] progress accuracy must not be NaN (step ${stats.global_steps})`)
        if (!isNaN(stats.loss_uncertainty)) t.ok(Number.isFinite(stats.loss_uncertainty), `[${modelVariant.id}] progress loss_uncertainty should be finite (step ${stats.global_steps})`)
        if (!isNaN(stats.accuracy_uncertainty)) t.ok(Number.isFinite(stats.accuracy_uncertainty), `[${modelVariant.id}] progress accuracy_uncertainty should be finite (step ${stats.global_steps})`)
        t.comment(`[${modelVariant.id}] progress: epoch=${stats.current_epoch + 1} step=${stats.global_steps} loss=${stats.loss?.toFixed(4)}±${stats.loss_uncertainty?.toFixed(4)} acc=${(stats.accuracy * 100)?.toFixed(1)}±${(stats.accuracy_uncertainty * 100)?.toFixed(1)}% backend_batch=${stats.current_batch}/${stats.total_batches}`)
      })
      t.comment(`${tag} ${ts()} sleeping 15s before pause`)
      await sleep(15000)
      t.comment(`${tag} ${ts()} sleep done, responseStatus=${finetuneHandle.getStatus()} progressCount=${progressCount}`)

      t.comment(`${tag} ${ts()} model.pause() START`)
      await model.pause()
      t.comment(`${tag} ${ts()} model.pause() DONE, responseStatus=${finetuneHandle.getStatus()}`)

      t.comment(`${tag} ${ts()} finetuneHandle.await() START`)
      const pauseResult = await finetuneHandle.await()
      t.comment(`${tag} ${ts()} finetuneHandle.await() DONE, status=${pauseResult?.status} op=${pauseResult?.op}`)
      assertLossAndAccuracyAreFinite(t, pauseResult, modelVariant.id)
      if (pauseResult?.status === 'COMPLETED') {
        t.comment(`${tag} ${ts()} EARLY-COMPLETION branch, result: ${JSON.stringify(pauseResult)}`)
        t.comment(`${tag} ${ts()} handleEarlyCompletion START`)
        await handleEarlyCompletion(
          t,
          finetuneHandle,
          checkpointDir,
          `[${modelVariant.id}] Finetuning completed too quickly`
        )
        t.comment(`${tag} ${ts()} handleEarlyCompletion DONE`)

        t.comment(`${tag} ${ts()} model.unload() START (early path)`)
        await model.unload().catch(() => {})
        t.comment(`${tag} ${ts()} model.unload() DONE`)
        t.comment(`${tag} ${ts()} loader.close() START`)
        await loader.close().catch(() => {})
        t.comment(`${tag} ${ts()} loader.close() DONE`)

        const loraAdapterPath = path.join(finetuneConfig.outputParametersDir, 'trained-lora-adapter.gguf')
        t.comment(`${tag} ${ts()} runLoraInference START`)
        await runLoraInference(t, modelVariant, modelName, modelDir, loraAdapterPath)
        t.comment(`${tag} ${ts()} runLoraInference DONE`)
        t.pass(`[${modelVariant.id}] finetuning (early) + LoRA inference completed`)
        continue
      }

      t.comment(`${tag} ${ts()} PAUSE-RESUME branch`)
      t.comment(`${tag} ${ts()} verifyPauseCheckpoint START`)
      await verifyPauseCheckpoint(t, checkpointDir, 2000)
      t.comment(`${tag} ${ts()} verifyPauseCheckpoint DONE`)

      t.comment(`${tag} ${ts()} model.finetune() resume START`)
      const resumeHandle = await model.finetune()
      t.comment(`${tag} ${ts()} model.finetune() resume returned handle, responseStatus=${resumeHandle.getStatus()}`)
      resumeHandle.on('stats', stats => {
        progressCount++
        t.ok(!isNaN(stats.loss), `[${modelVariant.id}] resume progress loss must not be NaN (step ${stats.global_steps})`)
        t.ok(!isNaN(stats.accuracy), `[${modelVariant.id}] resume progress accuracy must not be NaN (step ${stats.global_steps})`)
        if (!isNaN(stats.loss_uncertainty)) t.ok(Number.isFinite(stats.loss_uncertainty), `[${modelVariant.id}] resume progress loss_uncertainty should be finite (step ${stats.global_steps})`)
        if (!isNaN(stats.accuracy_uncertainty)) t.ok(Number.isFinite(stats.accuracy_uncertainty), `[${modelVariant.id}] resume progress accuracy_uncertainty should be finite (step ${stats.global_steps})`)
        t.comment(`[${modelVariant.id}] progress: epoch=${stats.current_epoch + 1} step=${stats.global_steps} loss=${stats.loss?.toFixed(4)}±${stats.loss_uncertainty?.toFixed(4)} acc=${(stats.accuracy * 100)?.toFixed(1)}±${(stats.accuracy_uncertainty * 100)?.toFixed(1)}% backend_batch=${stats.current_batch}/${stats.total_batches}`)
      })
      t.comment(`${tag} ${ts()} resumeHandle.await() START`)
      const result = await resumeHandle.await()
      t.comment(`${tag} ${ts()} resumeHandle.await() DONE, status=${result?.status}`)

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
      t.comment(`${tag} ${ts()} verifyFinalStatus START`)
      await verifyFinalStatus(t, model, result)
      t.comment(`${tag} ${ts()} verifyFinalStatus DONE`)
      t.pass(`[${modelVariant.id}] finetuning pause and resume completed`)

      t.comment(`${tag} ${ts()} model.unload() START (resume path)`)
      await model.unload().catch(() => {})
      t.comment(`${tag} ${ts()} model.unload() DONE`)
      t.comment(`${tag} ${ts()} loader.close() START`)
      await loader.close().catch(() => {})
      t.comment(`${tag} ${ts()} loader.close() DONE`)

      const loraAdapterPath = path.join(finetuneConfig.outputParametersDir, 'trained-lora-adapter.gguf')
      t.comment(`${tag} ${ts()} runLoraInference START`)
      await runLoraInference(t, modelVariant, modelName, modelDir, loraAdapterPath)
      t.comment(`${tag} ${ts()} runLoraInference DONE`)
      t.pass(`[${modelVariant.id}] finetuning + LoRA inference completed`)
    } finally {
      t.comment(`${tag} ${ts()} FINALLY block entered`)
      loggerHandle.release()
      t.comment(`${tag} ${ts()} model.unload() START (finally)`)
      await model.unload().catch(() => {})
      t.comment(`${tag} ${ts()} model.unload() DONE (finally)`)
      t.comment(`${tag} ${ts()} loader.close() START (finally)`)
      await loader.close().catch(() => {})
      t.comment(`${tag} ${ts()} loader.close() DONE (finally)`)
      cleanupCheckpoints(checkpointDir)
      t.comment(`${tag} ${ts()} FINALLY block done`)
    }
  }
})

test('cancel() stops finetuning and removes pause checkpoint', { timeout: PAUSE_RESUME_TIMEOUT_MS, skip: skipFinetuning }, async t => {
  const modelVariant = FINETUNE_MODELS[0]
  const [modelName, modelDir] = await ensureModel({
    modelName: modelVariant.name,
    downloadUrl: modelVariant.url
  })

  const finetuneConfig = setupParams(modelDir, { checkpointSaveSteps: 5, testId: 'cancel-test' })
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
    },
    finetuneConfig
  )

  const fs = require('bare-fs')

  try {
    t.comment(`[cancel][Flow] ${ts()} model.load() START`)
    await model.load()
    t.comment(`[cancel][Flow] ${ts()} model.load() DONE`)

    t.comment(`[cancel][Flow] ${ts()} model.finetune() START`)
    const finetuneHandle = await model.finetune(finetuneConfig)
    t.comment(`[cancel][Flow] ${ts()} model.finetune() returned handle, responseStatus=${finetuneHandle.getStatus()}`)
    t.comment(`[cancel][Flow] ${ts()} sleeping 15s`)
    await sleep(15000)
    t.comment(`[cancel][Flow] ${ts()} sleep done, responseStatus=${finetuneHandle.getStatus()}`)

    t.comment(`[cancel][Flow] ${ts()} model.cancel() START`)
    await model.cancel()
    t.comment(`[cancel][Flow] ${ts()} model.cancel() DONE, responseStatus=${finetuneHandle.getStatus()}`)
    t.comment(`[cancel][Flow] ${ts()} finetuneHandle.await() START`)
    const result = await finetuneHandle.await()
    t.comment(`[cancel][Flow] ${ts()} finetuneHandle.await() DONE, status=${result?.status}`)
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
    t.comment(`[cancel][Flow] ${ts()} FINALLY block entered`)
    loggerHandle.release()
    await model.unload().catch(() => {})
    await loader.close().catch(() => {})
    cleanupCheckpoints(checkpointDir)
    t.comment(`[cancel][Flow] ${ts()} FINALLY block done`)
  }
})

test('inference with session cache works after finetuning', { timeout: PAUSE_RESUME_TIMEOUT_MS, skip: skipFinetuning }, async t => {
  const modelVariant = FINETUNE_MODELS[0]
  const [modelName, modelDir] = await ensureModel({
    modelName: modelVariant.name,
    downloadUrl: modelVariant.url
  })

  const finetuneConfig = setupParams(modelDir, { checkpointSaveSteps: 5 })
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
    config,
    finetuneConfig
  )

  const fs = require('bare-fs')

  try {
    t.comment(`[session][Flow] ${ts()} model.load() START`)
    await model.load()
    t.comment(`[session][Flow] ${ts()} model.load() DONE`)

    const sessionPrompt = [
      { role: 'session', content: sessionFile },
      { role: 'user', content: 'What is 1+2? Answer with a number. /no_think' }
    ]
    t.comment(`[session][Flow] ${ts()} pre-finetune model.run() START`)
    const preResponse = await model.run(sessionPrompt)
    t.comment(`[session][Flow] ${ts()} pre-finetune model.run() returned, awaiting output`)
    let preOutput = ''
    await preResponse.onUpdate(token => { preOutput += token }).await()
    t.comment(`[session][Flow] ${ts()} pre-finetune inference DONE, output length=${preOutput.length}`)
    t.ok(preOutput.length > 0, 'Pre-finetune inference with session should produce output')
    t.comment(`Pre-finetune output: ${preOutput}`)

    t.comment(`[session][Flow] ${ts()} model.finetune() START`)
    const finetuneHandle = await model.finetune(finetuneConfig)
    t.comment(`[session][Flow] ${ts()} model.finetune() returned handle, responseStatus=${finetuneHandle.getStatus()}`)
    t.comment(`[session][Flow] ${ts()} finetuneHandle.await() START`)
    const result = await finetuneHandle.await()
    t.comment(`[session][Flow] ${ts()} finetuneHandle.await() DONE, status=${result?.status}`)
    t.ok(result, 'Finetune should return a result')
    t.comment(`Finetune result: ${JSON.stringify(result)}`)

    const postPrompt = [
      { role: 'session', content: sessionFile },
      { role: 'user', content: 'What is the output of the previous computation? answer with a number. /no_think' }
    ]
    t.comment(`[session][Flow] ${ts()} post-finetune model.run() START`)
    const postResponse = await model.run(postPrompt)
    t.comment(`[session][Flow] ${ts()} post-finetune model.run() returned, awaiting output`)
    let postOutput = ''
    await postResponse.onUpdate(token => { postOutput += token }).await()
    t.comment(`[session][Flow] ${ts()} post-finetune inference DONE, output length=${postOutput.length}`)
    t.ok(postOutput.length > 0, 'Post-finetune inference with session should produce output')
    t.ok(postOutput.includes('3'), 'Post-finetune output should include the output of the previous computation')
    t.comment(`Post-finetune output: ${postOutput}`)

    t.pass('Inference with session cache works after finetuning')
  } finally {
    t.comment(`[session][Flow] ${ts()} FINALLY block entered`)
    loggerHandle.release()
    await model.unload().catch(() => {})
    await loader.close().catch(() => {})
    cleanupCheckpoints(checkpointDir)
    try { fs.unlinkSync(sessionFile) } catch (_) {}
    t.comment(`[session][Flow] ${ts()} FINALLY block done`)
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
      { gpu_layers: '999', ctx_size: '512', device: forceCpuDevice ? 'cpu' : 'gpu', verbosity: '0' },
      config
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
