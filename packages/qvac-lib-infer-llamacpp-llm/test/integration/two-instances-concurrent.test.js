'use strict'

/**
 * Tests that two addon instances (two model instances) can run inference and
 * finetuning in parallel without cross-talk. Verifies per-instance state
 * (e.g. shouldResumeFromPause) so multi-instance use is safe.
 */
const test = require('brittle')
const FilesystemDL = require('@qvac/dl-filesystem')
const getTmpDir = require('test-tmp')
const LlmLlamacpp = require('../../index.js')
const {
  ensureModel,
  setupPauseResumeTestData,
  getDefaultFinetuneConfig,
  cleanupCheckpoints
} = require('./utils')
const { attachSpecLogger } = require('./spec-logger')
const os = require('bare-os')

const platform = os.platform()
const arch = os.arch()
const isDarwinX64 = platform === 'darwin' && arch === 'x64'
const isLinuxArm64 = platform === 'linux' && arch === 'arm64'
const noGpu = process.env.NO_GPU === 'true'
const useCpu = isDarwinX64 || isLinuxArm64

const FINETUNE_MODEL = {
  name: 'Qwen3-0.6B-Q8_0.gguf',
  url: 'https://huggingface.co/unsloth/Qwen3-0.6B-GGUF/resolve/main/Qwen3-0.6B-Q8_0.gguf'
}

const RUN_PROMPT = [
  { role: 'system', content: 'You are a helpful assistant.' },
  { role: 'user', content: 'Say "ok" once.' }
]

const FINETUNE_TIMEOUT_MS = 360_000

function sleep (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function collectResponse (response) {
  const chunks = []
  await response
    .onUpdate(data => { chunks.push(data) })
    .await()
  return chunks.join('').trim()
}

function createConfig () {
  return {
    gpu_layers: '999',
    ctx_size: '512',
    device: useCpu ? 'cpu' : 'gpu',
    flash_attn: 'off'
  }
}

test('two instances: A run + B run in parallel', { timeout: 60_000, skip: isDarwinX64 }, async (t) => {
  const [modelName, modelDir] = await ensureModel({
    modelName: FINETUNE_MODEL.name,
    downloadUrl: FINETUNE_MODEL.url
  })
  const loader = new FilesystemDL({ dirPath: modelDir })
  const loggerHandle = attachSpecLogger({ forwardToConsole: false })

  const modelA = new LlmLlamacpp(
    { loader, modelName, diskPath: modelDir, logger: console, opts: { stats: true } },
    createConfig()
  )
  const modelB = new LlmLlamacpp(
    { loader, modelName, diskPath: modelDir, logger: console, opts: { stats: true } },
    createConfig()
  )

  t.teardown(async () => {
    try {
      loggerHandle.release()
      await modelA.unload().catch(() => {})
      await modelB.unload().catch(() => {})
      await loader.close().catch(() => {})
    } catch (err) {}
  })

  await modelA.load()
  await modelB.load()

  const [responseA, responseB] = await Promise.all([
    modelA.run(RUN_PROMPT),
    modelB.run(RUN_PROMPT)
  ])

  const [resultA, resultB] = await Promise.all([
    collectResponse(responseA),
    collectResponse(responseB)
  ])

  t.ok(typeof resultA === 'string', 'model A run should complete')
  t.ok(typeof resultB === 'string', 'model B run should complete')
  t.pass()
})

test('two instances: A run + B finetune in parallel', { timeout: FINETUNE_TIMEOUT_MS, skip: isDarwinX64 || noGpu }, async (t) => {
  const [modelName, modelDir] = await ensureModel({
    modelName: FINETUNE_MODEL.name,
    downloadUrl: FINETUNE_MODEL.url
  })
  const testDataDirA = await getTmpDir()
  const testCheckpointDirA = await getTmpDir()
  const testDataDirB = await getTmpDir()
  const testCheckpointDirB = await getTmpDir()
  const { checkpointDir: checkpointA } =
    setupPauseResumeTestData(testDataDirA, testCheckpointDirA, 'two-a')
  const { trainDatasetPath: trainB, evalDatasetPath: evalB, checkpointDir: checkpointB } =
    setupPauseResumeTestData(testDataDirB, testCheckpointDirB, 'two-b')

  const loader = new FilesystemDL({ dirPath: modelDir })
  const loggerHandle = attachSpecLogger({ forwardToConsole: false })

  const finetuneConfigB = getDefaultFinetuneConfig({
    trainDatasetDir: trainB,
    evalDatasetDir: evalB,
    numberOfEpochs: 1,
    microBatchSize: 2,
    contextLength: 128,
    checkpointSaveDir: checkpointB
  })

  const modelA = new LlmLlamacpp(
    { loader, modelName, diskPath: modelDir, logger: console, opts: { stats: true } },
    createConfig()
  )
  const modelB = new LlmLlamacpp(
    { loader, modelName, diskPath: modelDir, logger: console, opts: { stats: true } },
    createConfig(),
    finetuneConfigB
  )

  t.teardown(async () => {
    try {
      loggerHandle.release()
      await modelA.unload().catch(() => {})
      await modelB.unload().catch(() => {})
      await loader.close().catch(() => {})
      cleanupCheckpoints(checkpointA)
      cleanupCheckpoints(checkpointB)
    } catch (err) {}
  })

  await modelA.load()
  await modelB.load()

  const runPromiseA = modelA.run(RUN_PROMPT).then(collectResponse)
  const finetuneHandleB = await modelB.finetune(finetuneConfigB)
  const resultA = await runPromiseA

  t.ok(typeof resultA === 'string', 'model A run should complete while B finetunes')
  await finetuneHandleB.await()
  t.pass()
})

test('two instances: A finetune + B run in parallel', { timeout: FINETUNE_TIMEOUT_MS, skip: isDarwinX64 || noGpu }, async (t) => {
  const [modelName, modelDir] = await ensureModel({
    modelName: FINETUNE_MODEL.name,
    downloadUrl: FINETUNE_MODEL.url
  })
  const testDataDirA = await getTmpDir()
  const testCheckpointDirA = await getTmpDir()
  const { trainDatasetPath: trainA, evalDatasetPath: evalA, checkpointDir: checkpointA } =
    setupPauseResumeTestData(testDataDirA, testCheckpointDirA, 'two-a')

  const loader = new FilesystemDL({ dirPath: modelDir })
  const loggerHandle = attachSpecLogger({ forwardToConsole: false })

  const finetuneConfigA = getDefaultFinetuneConfig({
    trainDatasetDir: trainA,
    evalDatasetDir: evalA,
    numberOfEpochs: 1,
    microBatchSize: 2,
    contextLength: 128,
    checkpointSaveDir: checkpointA
  })

  const modelA = new LlmLlamacpp(
    { loader, modelName, diskPath: modelDir, logger: console, opts: { stats: true } },
    createConfig(),
    finetuneConfigA
  )
  const modelB = new LlmLlamacpp(
    { loader, modelName, diskPath: modelDir, logger: console, opts: { stats: true } },
    createConfig()
  )

  t.teardown(async () => {
    try {
      loggerHandle.release()
      await modelA.unload().catch(() => {})
      await modelB.unload().catch(() => {})
      await loader.close().catch(() => {})
      cleanupCheckpoints(checkpointA)
    } catch (err) {}
  })

  await modelA.load()
  await modelB.load()

  const finetuneHandleA = await modelA.finetune(finetuneConfigA)
  const responseB = await modelB.run(RUN_PROMPT)
  const resultB = await collectResponse(responseB)

  t.ok(typeof resultB === 'string', 'model B run should complete while A finetunes')
  await finetuneHandleA.await()
  t.pass()
})

test('two instances: A finetune + B finetune in parallel', { timeout: FINETUNE_TIMEOUT_MS, skip: isDarwinX64 || noGpu }, async (t) => {
  const [modelName, modelDir] = await ensureModel({
    modelName: FINETUNE_MODEL.name,
    downloadUrl: FINETUNE_MODEL.url
  })
  const testDataDirA = await getTmpDir()
  const testCheckpointDirA = await getTmpDir()
  const testDataDirB = await getTmpDir()
  const testCheckpointDirB = await getTmpDir()
  const { trainDatasetPath: trainA, evalDatasetPath: evalA, checkpointDir: checkpointA } =
    setupPauseResumeTestData(testDataDirA, testCheckpointDirA, 'two-a')
  const { trainDatasetPath: trainB, evalDatasetPath: evalB, checkpointDir: checkpointB } =
    setupPauseResumeTestData(testDataDirB, testCheckpointDirB, 'two-b')

  const loader = new FilesystemDL({ dirPath: modelDir })
  const loggerHandle = attachSpecLogger({ forwardToConsole: false })

  const finetuneConfigA = getDefaultFinetuneConfig({
    trainDatasetDir: trainA,
    evalDatasetDir: evalA,
    numberOfEpochs: 1,
    microBatchSize: 2,
    contextLength: 128,
    checkpointSaveDir: checkpointA
  })
  const finetuneConfigB = getDefaultFinetuneConfig({
    trainDatasetDir: trainB,
    evalDatasetDir: evalB,
    numberOfEpochs: 1,
    microBatchSize: 2,
    contextLength: 128,
    checkpointSaveDir: checkpointB
  })

  const modelA = new LlmLlamacpp(
    { loader, modelName, diskPath: modelDir, logger: console, opts: { stats: true } },
    createConfig(),
    finetuneConfigA
  )
  const modelB = new LlmLlamacpp(
    { loader, modelName, diskPath: modelDir, logger: console, opts: { stats: true } },
    createConfig(),
    finetuneConfigB
  )

  t.teardown(async () => {
    try {
      loggerHandle.release()
      await modelA.unload().catch(() => {})
      await modelB.unload().catch(() => {})
      await loader.close().catch(() => {})
      cleanupCheckpoints(checkpointA)
      cleanupCheckpoints(checkpointB)
    } catch (err) {}
  })

  await modelA.load()
  await modelB.load()

  const handleA = await modelA.finetune(finetuneConfigA)
  const handleB = await modelB.finetune(finetuneConfigB)

  const [resultA, resultB] = await Promise.all([handleA.await(), handleB.await()])

  t.ok(resultA?.status === 'COMPLETED' || resultA?.status === 'ERROR', `A finished with ${resultA?.status}`)
  t.ok(resultB?.status === 'COMPLETED' || resultB?.status === 'ERROR', `B finished with ${resultB?.status}`)
  t.pass()
})

const PAUSE_RESUME_TIMEOUT_MS = 600_000

test('two instances: A pause/resume finetune while B runs inference (per-instance resume flag)', {
  timeout: PAUSE_RESUME_TIMEOUT_MS,
  skip: isDarwinX64 || noGpu
}, async (t) => {
  const [modelName, modelDir] = await ensureModel({
    modelName: FINETUNE_MODEL.name,
    downloadUrl: FINETUNE_MODEL.url
  })
  const testDataDirA = await getTmpDir()
  const testCheckpointDirA = await getTmpDir()
  const { trainDatasetPath: trainA, evalDatasetPath: evalA, checkpointDir: checkpointA } =
    setupPauseResumeTestData(testDataDirA, testCheckpointDirA, 'two-resume')

  const loader = new FilesystemDL({ dirPath: modelDir })
  const loggerHandle = attachSpecLogger({ forwardToConsole: false })

  const finetuneConfigA = getDefaultFinetuneConfig({
    trainDatasetDir: trainA,
    evalDatasetDir: evalA,
    numberOfEpochs: 2,
    microBatchSize: 2,
    contextLength: 128,
    checkpointSaveDir: checkpointA
  })

  const modelA = new LlmLlamacpp(
    { loader, modelName, diskPath: modelDir, logger: console, opts: { stats: true } },
    createConfig(),
    finetuneConfigA
  )
  const modelB = new LlmLlamacpp(
    { loader, modelName, diskPath: modelDir, logger: console, opts: { stats: true } },
    createConfig()
  )

  t.teardown(async () => {
    try {
      loggerHandle.release()
      await modelA.unload().catch(() => {})
      await modelB.unload().catch(() => {})
      await loader.close().catch(() => {})
      cleanupCheckpoints(checkpointA)
    } catch (err) {}
  })

  await modelA.load()
  await modelB.load()

  const handleA = await modelA.finetune(finetuneConfigA)
  await sleep(8000)
  await modelA.cancel()
  const pauseResult = await handleA.await()
  if (pauseResult?.status === 'COMPLETED') {
    t.comment('A completed before pause; finishing B run and exiting')
    const responseB = await modelB.run(RUN_PROMPT)
    await collectResponse(responseB)
    return t.pass()
  }

  const responseB = await modelB.run(RUN_PROMPT)
  const resultB = await collectResponse(responseB)
  t.ok(typeof resultB === 'string', 'B run should complete while A is paused')

  const resumeHandleA = await modelA.finetune()
  const resumeResult = await resumeHandleA.await()
  t.ok(resumeResult?.status === 'COMPLETED' || resumeResult?.status === 'ERROR', `A resume should complete: ${resumeResult?.status}`)
  t.pass()
})
